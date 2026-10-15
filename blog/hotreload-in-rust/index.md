# Hotreload in Rust

Hotreloading lets you change the code of a running application. This removes the need to restart the program after every change. It also keeps the state of a program intact, so you don’t need to go through chores like connecting to DB, opening and editing test files, or arranging dummies for a car crash simulation in your physics engine again.

Today I'd like to tell you how to effortlessly hotreload Rust code and how I've done it in my [`hotcode`](https://crates.io/crates/hotcode) crate using dynamic libraries.

## Dynamic Library

> _This section briefly describes what a dynamic library is and how it works. If you already know it you can skip this part._

A dynamic library is a collection of precompiled code represented by a file on disk. Its code can be loaded at run-time by your application using special OS functions. You give the path to a dynamic library file to the OS and it loads it into your process's memory, returning a handle to an OS object. Then you search for your function in the dynamic library using its symbol. A symbol is just a unique name represented by a string of bytes. Rust allows you to set it explicitly using the [`export_name`](https://doc.rust-lang.org/reference/abi.html#the-export_name-attribute) attribute:

```rust
#[unsafe(export_name = "my_function_symbol")]
pub fn my_function() {}
```

To load a dynamic library in Rust, there is a [`libloading`](https://crates.io/crates/libloading) crate that allows you to do it fairly easily:

```rust
use libloading::*;

let lib = Library::new("/path/to/liblibrary.so").unwrap();
let func: Symbol<unsafe extern "C" fn() -> u32> = lib.get(b"my_function").unwrap();
unsafe { func() }; // function loaded from dynamic library
```

To make your crate produce a dynamic library instead of an object library you need to set the crate type in `Cargo.toml` to either `dylib` or `cdylib`:

```toml
[lib]
crate-type = ["dylib"]
# or
crate-type = ["cdylib"]
```

`dylib` is intended to be used by other Rust crates and uses unstable (as of now) Rust ABI. `cdylib` is intended to be used by foreign languages. It produces smaller libraries because it strips Rust's metadata. For information about various crate types, you can read about [Linkage](https://doc.rust-lang.org/reference/linkage.html) in the Rust reference.

## Reloading code with dynamic library

One of the simplest ways of achieving hotreloading in Rust is to use dynamic libraries to update function's code. The idea is simple - instead of calling a statically linked function we load a dynamic library and call a function from there. Then, after we change our code, we unload the previously loaded library and reload the updated version. It looks roughly like this:

```rust
let path = "path/to/dynamic/library";
let lib = libloading::Library::new(path);
let func = lib.get<fn() -> i32>(b"my_function");

let first_result = func();

// ...
// wait for dynamic library to update
// ...

drop(lib); // unload previous dynamic library
let lib = libloading::Library::new(path);
let func = lib.get<fn() -> i32>(b"my_function");

let second_result = func(); // use changed function

assert_ne!(first_result, second_result);
```

This is basically the whole idea. But there are some limitations:

1. Loading and usage of a dynamic library must be performed in a [binary](https://doc.rust-lang.org/cargo/reference/cargo-targets.html#binaries) or separate executable crate. `my_function` should be placed in a `dylib` crate because we will load our Rust library only from Rust, so there is no need to use `cdylib`.

2. Another dynamic library limitation is that you can not export functions with generics through them.

  <details>
    <summary>Why generics can not be exported in dynamic libraries?</summary>
    Because a function's definition alone is not enough for the compiler to generate real code, it also needs to know exactly how this function is used. For example, if we write:

    ```rust
    fn string_value<T: ToString>(t: &T) -> String {
        t.to_string()
    }

    string_value(&1);
    string_value("quo vadis");
    ```

    the compiler will generate two implementations of `string_value`: one for `i32` and one for `&str` because it uses static linking and knows all usage scenarios of `string_value`. When we build a library for dynamic linking we can not know beforehand how our exported function will be used. One way to circumvent that is to use trait objects and dynamic dispatch:

    ```rust
    pub fn string_value(t: &dyn ToString) -> String {
       t.to_string()
    }
    ```

    Another way is to create concrete type wrappers:
    ```rust
    pub fn string_value_i32(value: &i32) -> String {
      string_value(value)
    }
    ```
  </details>

Next we will focus on implementation details: 1. how to store a dynamic library, 2. how to wait for a dynamic library to update, and 3. how to make it convenient to use.

## 1. Dynamic library storage

A dynamic library is represented in code as a `libloading::Library` struct - a wrapper over a handle to an OS object. This handle must be kept alive while there are functions whose instructions are currently being read and executed in any thread. If you unload a dynamic library while its function is running you will get undefined behavior.

### Protection against in-use unload

To protect us from accidentally unloading a dynamic library that is still in use we can store it in a reference-counted pointer and create a function wrapper that keeps it. We will use `Arc` because dynamic libraries can be safely used from any thread:

```rust
struct FnGuard<F> {
    f: F,
    _lib_arc: Arc<libloading::Library>,
}

unsafe fn get_fn<F>(lib: Arc<libloading::Library>, fn_name: &[u8]) -> FnGuard<F> {
    let fn_ptr = lib.get::<fn()>(fn_name).unwrap().try_as_raw_ptr().unwrap();
    let f = core::mem::transmute_copy(&fn_ptr.cast::<()>());
    let result = FnGuard { f, _lib_arc: lib.clone() };
    return result;
}

// for ability to call it like this:
// let fn_guard = get_fn(...);
// fn_guard();
impl<F> Deref for FnGuard<F> {
    type Target = F;

    fn deref(&self) -> &Self::Target {
        &self.f
    }
}

// usage
let lib = Arc::new(libloading::Library::new(...));
let f = lib.get_fn<fn() -> i32>(b"my_function_symbol");
f();
```

Now when we call a function loaded from a dynamic library (that we get through `get_fn`) the guard will guarantee that there will be at least one reference to the dynamic library until the function finishes execution. We no longer have to worry that the library could be accidentally unloaded while it is still in use.

Next, let's try to make `get_fn` faster.

### Faster up function search

Symbol lookup can be a relatively costly operation. Fortunately, its result can be cached because symbols in a dynamic library can not move. The first time we obtain a pointer to one of them, we can cache it in a symbol name map. We can create a wrapper over `libloading::Library` that holds the inner library, exposes the `get_fn` method and keeps a cache of symbol pointers:

```rust
struct LibraryWrapper {
    inner: libloading::Library,
    symbols_map: RwLock<HashMap<&'static [u8], *mut core::ffi::c_void>>,
}

pub unsafe fn get_fn<F>(lib: Arc<RwLock<Self>>, symbol_name: &'static [u8]) -> FnGuard<F> {
    let fn_ptr =
        if let Some(existing) = lib.symbols_map.read().unwrap().get(symbol_name) {
            *existing
        } else {
            let mut write = lib.symbols_map.write().unwrap();
            let raw_fn_ptr = lib
                .inner
                .get::<fn()>(symbol_name)
                .unwrap()
                .try_as_raw_ptr()
                .unwrap();
            write.insert(symbol_name, raw_fn_ptr);
            raw_fn_ptr
        };
    let f = core::mem::transmute_copy(&fn_ptr.cast::<()>());
    let result = FnGuard { f, _lib_arc: lib.clone() };
    return result;
}

// usage
let lib = LibraryWrapper::new(...); // same args as for `libloading::Library::new`
let f = lib.get_fn<fn() -> i32>(b"my_function_symbol");
f();
```

Now we can store a dynamic library in a convenient `LibraryWrapper` structure that ensures library's lifetime and offers fast function search.

## 2. Dynamic library update

We want our application to automatically reload a dynamic library whenever we rebuild our library. To do it we need to watch for changes of our compiled dynamic library file. This can be done using the [`notify`](https://crates.io/crates/notify) crate - it provides cross-platform file system watchers. A watcher lives in a separate thread and performs a callback whenever the target file receives specified changes: creation, deletion, modification and so on. Here's a basic usage example:

```rust
let mut watcher = notify::recommended_watcher(|res: Result<notify::Event, notify::Error>| {
    match res {
        Ok(event) => {
            println!("Changed: {:?}", event.paths);
            println!("Event details: {:?}", event.kind);
        }
        Err(e) => println!("Watch error: {:?}", e),
    }
}).unwrap();

watcher.watch("path/to/file/or/directory".as_ref(), RecursiveMode::Recursive).unwrap();
```

The closure we passed will be called each time the target file or any file in the target directory is changed. Note that you may need to use the debounced version: [`notify-debouncer-full`](https://crates.io/crates/notify-debouncer-full) because Cargo may write the file multiple times, but for the sake of simplicity we will use the regular version. We can run it to watch our dynamic library file and pass an `Arc` to the closure, but we won't be able to reload our library because `Arc` does not allow mutating its contents.

A naive approach to solve it would be to store a `Mutex` in an `Arc` to be able to lock, unload and reload our library in the watcher's callback.  
A better approach would be to use `RwLock`, since we mostly read from the dynamic library - this happens each time we try to extract a pointer to a function from it using `get_fn` - and rarely write to it - only when we rebuild it.  
An even better approach would be to use the `ArcSwap` struct from the [`arc-swap`](https://crates.io/crates/arc-swap) crate. It stores an `Arc` that it can atomically change. It allows us to reload a dynamic library without blocking at all!

It works like this: suppose we've called the function `foo` from a dynamic library. Then, while it's still executing, we receive a notification from the watcher that the dynamic library has changed. We load the new version of the library without unloading the previous one because it is still in use by the first call of `foo`. We store the new version of the dynamic library in our `ArcSwap` and any subsequent calls to `foo` will now use the new version of this function. The `Arc` to the previous version of the library was removed from `ArcSwap`, so it's no longer possible to call any function from the previous library, but it will still be present in memory as long as the first `foo` call is still running. The moment it is done, its `FnGuard` will drop the last `Arc` to the previous library and it will automatically unload.

Together with the file watcher, our code will look like this:

```rust
// main - one-time setup
let path = "path/to/dynamic/library";
let lib = Arc::new(ArcSwap::from_pointee(LibraryWrapper::new(path)));

let lib_for_callback = lib.clone();
let mut watcher = notify::recommended_watcher(|res| {
    let event = res.unwrap();
    if event.paths.contains(path) {
        let new_lib = LibraryWrapper::new(path);
        lib_for_callback.store(Arc::new(new_lib));  // store new library
    }
}).unwrap();
watcher.watch(path, notify::RecursiveMode::NonRecursive).unwrap();

// usage
let func = lib
    .load_full()    // `ArcSwap` method
    .get_fn<fn() -> i32>(b"my_function");
let result = func();
```

There is one last important thing that we must do - copy a dynamic library file to some temp file so that the `LibraryWrapper` instance won't hold a lock on the compilable file and block rebuilding. This can be easily tweaked in `LibraryWrapper::new`:

```rust
struct LibraryWrapper {
    inner: libloading::Library,
    symbols_map: RwLock<HashMap<&'static [u8], *mut core::ffi::c_void>>,
    lib_path: PathBuf   // adding this field to remember where library
                        // was loaded from (`libloading::Library`
                        // does not store path to its library file)
}

impl LibraryWrapper {
    pub fn new(path: PathBuf) -> Self {
        let copy_path = temp_path();
        std::fs::copy(&path, &copy_path).unwrap();
        let inner = libloading::Library::new(copy_path);

        Self {
            inner,
            symbols_map: Default::default(),
            lib_path: copy_path
        }
    }
}

impl Drop for LibraryWrapper {
    fn drop(&mut self) {
        // do not forget to remove copy of dynamic library
        self.inner.close().unwrap();
        std::fs::remove_file(&self.lib_path);
    }
}
```

Lastly, let's try to make this infrastructure easy to use.

## 3. Simplifying usage

As you can see, right now we need to do a lot of things to hotreload functions: initialize the library, spawn the watcher, manually load required functions before calling them, etc. However, all these steps can be replaced with a single macro attribute:

```rust
// what we are aiming for
#[hotreload]
fn foo() {}
```

First, let's optimize library initialization and spawn the watcher.

### Lazy dynamic library initialization

We can put the dynamic library behind a `LazyLock` in a static variable and let the library initialize itself the first time we need to call a function from it:

```rust
static DYNAMIC_LIBRARY: LazyLock<Arc<ArcSwap<LibraryWrapper>>> =
    LazyLock::new(initialize_dynamic_library);

fn initialize_dynamic_library() -> Arc<ArcSwap<LibraryWrapper>> {
    let library_file_name = "your_library_name.so";
    let library_source_path = std::env::current_exe()
        .unwrap()
        .parent()
        .unwrap()
        .join(library_file_name);
    let shared_library_wrapper = Arc::new(ArcSwap::from_pointee(LibraryWrapper::new(
        library_source_path.clone(),
    )));

    spawn_library_watcher(
        library_source_path,
        shared_library_wrapper.clone(),
    );
    return shared_library_wrapper;
}

// usage
let f = (*DYNAMIC_LIBRARY).get_fn<fn() -> i32>(b"my_function");
f();
```

Next, let's replace this:
```rust
#[unsafe(export_name = "my_function")]
fn my_function() {}

let f = (*DYNAMIC_LIBRARY).get_fn<fn() -> i32>(b"my_function");
f();
```
with this:
```rust
#[hotreload]    // procedural macro
fn my_function() {}

my_function();
```
This way we can call our hotreloadable functions without changing their call sites. To do it we need to enable both static and dynamic linking of our library crate; this can be done by using both `rlib` and `dylib` crate types in `Cargo.toml`:
```toml
[lib]
crate-type = ["rlib", "dylib"]
```
This will force the Rust compiler to generate both `my_library.rlib` and `my_library.so` files. The `.rlib` file contains object code (`.o`) and Rust metadata. It is needed for static linking of the library so that we can call its functions directly in our executable's code.

Then we need to modify the source function with our macro so that it will load the dynamic library when called statically and execute actual function instructions when called through the dynamic library. We have two ways to do it using our `#[hotreload]` macro:
1. Generate two versions of our function: one will bear the same name and be an entrypoint for static calls that loads the dynamic library; second will have the actual function body and export name so that it can be loaded from the dynamic library. This approach turns this:
   ```rust
   #[hotreload]
   fn my_function(v: i32) -> i32 { v + 1 }
   ```
   into this:
   ```rust
   // entrypoint for static calls
   fn my_function(v: i32) -> i32 {
       let f = (*DYNAMIC_LIBRARY).get_fn<fn(i32) -> i32>(b"__hotreload_my_function");
       f(v)
   }
   
   // actual implementation reachable only through dynamic library
   #[unsafe(export_name = "__hotreload_my_function")]
   fn __hotreload_my_function(v: i32) -> i32 { v + 1 }
   ```
   However, this would not work for functions inside trait implementations, because it creates a new function that is not part of the trait definition.
2. Add a check for whether we're currently in a statically or dynamically linked function inside each hotreloadable function. If we're inside a statically linked function, then we need to load the dynamic library and call it. If we're inside a dynamically linked function, then we just execute actual function's instructions. This approach turns this:
   ```rust
   #[hotreload]
   fn my_function(v: i32) -> i32 { v + 1 }
   ```
   into this:
   ```rust
   #[unsafe(export_name = "__hotreload_my_function")]
   fn my_function(v: i32) -> i32 {
       if is_outside_dynamic_library() {
           let f = (*DYNAMIC_LIBRARY).get_fn<fn(i32) -> i32>(b"__hotreload_my_function");
           return f(v);
       }
       // source function's body
       v + 1
   }
   ```
   This approach can be used in any function because it does not change its signature or create new syntax items - it only modifies the function's body. This allows it to be used even inside trait implementations, contrary to the first approach:
   ```rust
   impl Trait for Struct {
       #[hotreload]
       fn work(&self) { self.do_something(); }
   }
   ```

Initially I used the first approach in `hotcode`, but I was unsatisfied with the fact that this macro can't be used anywhere, so I came up with the second option that we will use.

### Checking whether we are inside dynamic library

This check is the core component for our system. To perform it we need to ask the OS for information about current function's address space and map it to the executable module name. If it matches `std::env::current_exe()`, then it means that we are inside a statically linked function, otherwise - in the dynamic library. Platform-agnostic pseudocode for this check looks something like this:
```rust
fn is_outside_dynamic_library() -> bool {
    let current_fn_ptr = is_outside_dynamic_library as *const _;
    let current_module_name = os::get_module_name_from_ptr(current_fn_ptr);
    return current_module_name != std::env::current_exe();
}
```
Notice that we do not need to pass the pointer to the function that we're trying to hotreload - the `is_outside_dynamic_library`'s pointer is enough to determine the current module name, because it will also exist in two variants - as a statically linked and a dynamically linked function.

On Linux `get_module_name_from_ptr` uses the `dladdr` libc function; on Windows - `GetModuleHandleExW` and `GetModuleFileNameW` OS functions. Performing this check for each hotreloadable function call can be unacceptable on hot paths. Fortunately, the result of this function can also be cached! We can define a static lazy bool variable and cache the check result in it:
```rust
fn is_outside_dynamic_library() -> bool {
    *IS_OUTSIDE_DYNAMIC_LIBRARY
}

static IS_OUTSIDE_DYNAMIC_LIBRARY: LazyLock<bool> =
    LazyLock::new(slow_is_outside_dynamic_library);

fn slow_is_outside_dynamic_library() -> bool {
    let current_fn_ptr = is_outside_dynamic_library as *const _;
    let current_module_name = os::get_module_name_from_ptr(current_fn_ptr);
    return current_module_name != std::env::current_exe();
}
```

This works because each dynamic library has its own set of static variables. This means that in our host process that calls hotreloadable functions, the `IS_OUTSIDE_DYNAMIC_LIBRARY` will cache to `false`, and in dynamic libraries that we load it will cache to `true`. We can safely cache it once and never rerun this check afterwards because the function can not move inside process memory. This way overhead for calling hotreloadable functions becomes negligible.

### Supporting multiple libraries

There is one more little improvement that we can do. Suppose that your binary uses multiple of your libraries whose functions you want to hotreload. The current implementation will panic on `unwrap` of `libloading::Library::get` result when you try to load a function from the second library after the first library has already initialized the static `DYNAMIC_LIBRARY` variable. This can be easily solved by storing `RwLock<HashMap<String, Arc<ArcSwap<LibraryWrapper>>>>` in `DYNAMIC_LIBRARY` - a cache that maps a library to its `LibraryWrapper`:

```rust
pub static DYNAMIC_LIBRARIES_MAP: LazyLock<RwLock<HashMap<String, Arc<ArcSwap<LibraryWrapper>>>>> =
    LazyLock::new(Default::default);

// new function to provide library wrappers for concrete crate
pub fn provide_library_wrapper(library_file_name: String) -> Arc<LibraryWrapper> {
    let library = if let Some(existing) = DYNAMIC_LIBRARIES_MAP.read().unwrap().get(&library_file_name) {
        existing
    } else {
        let mut write = DYNAMIC_LIBRARIES_MAP.write().unwrap();
        let library_source_path = std::env::current_exe()
            .unwrap()
            .parent()
            .unwrap()
            .join(library_file_name);
        let shared_library_wrapper = Arc::new(ArcSwap::from_pointee(LibraryWrapper::new(
            library_source_path.clone(),
        )));
        library_watcher::spawn(
            library_file_name.to_owned(),   // <- also pass actual library name to watcher,
            library_source_path,            //    because we will need one watcher for
            shared_library_wrapper.clone(), //    each hotreloadable dynamic library
        );
        write.insert(library_file_name, shared_library_wrapper);
        shared_library_wrapper
    }
    return library.load_full();
}
```

We can also extract the name of a crate in which our `#[hotreload]` macro is being called using the `CARGO_PKG_NAME` environment variable like this: `std::env::var("CARGO_PKG_NAME").unwrap()` and pass it instead of previously hardcoded `"your_library_name.so"`.

### Result

Now all we have to do to make a function hotreloadable is to apply the `#[hotreload]` attribute:
```rust
#[hotreload]
fn my_function() {}

impl Struct {
    #[hotreload]
    fn my_function(&self) {}
    #[hotreload]
    fn my_static_function() {}
}

impl Trait for Struct {
    #[hotreload]
    fn my_function(&self) {}
    #[hotreload]
    fn my_static_function() {}
}
// and any other function that you may find
```

We also didn't sacrifice much performance - in the worst case we'll have to do three relatively slow initializations: loading the library from disk, calling an OS function to check if we're inside the dynamic library, and searching for the required function in the loaded dynamic library. In the best case we load values from two `LazyLock`s and extract an existing entry from `HashMap`.

## Conclusion and acknowledgements

This was a fun project to do, but this is not the first attempt at bringing hotreloading to Rust. Here are some other attempts that I found interesting:

1. [`hot-lib-reloader`](https://crates.io/crates/hot-lib-reloader) - this crate also uses dynamic libraries for hotreloading, but requires a lot more configuration.
2. [`subsecond`](https://crates.io/crates/subsecond) - solution by the Dioxus team that uses hotpatching and custom linker. Requires Dioxus CLI and wrapping hotreloadable code in `subsecond::call`.
3. [`inline_tweak`](https://crates.io/crates/inline_tweak) - zero-dependency solution that hotreloads literal values. Easy to use with a single macro.

That's it for now, hope your iteration cycles will be faster!
