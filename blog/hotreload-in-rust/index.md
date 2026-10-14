# Hotreload in Rust

Hotreloading lets you change the code of a running application. This removes the need to restart the program after every change. It also keeps the state of a program in-tact, so you don’t need to go through the chores of things like connecting to DB, openning and editing test file, or arranging dummies for a car crash simulation in your physics engine again.

Today I'd like to tell you how to effortlessly hotreload Rust code and how I've done it in my [`hotcode`](https://crates.io/crates/hotcode) crate using dynamic libraries.

## Dynamic Library

> _This section contains short description of what a dynamic library is and how it works. If you already know it you can skip this part._

Dynamic library is a collection of precompiled code represented by a file on disk. It's code can be loaded at run-time by your application using special OS functions. You give the path to dynamic library file to OS and it loads it into your process' memory, returning you a handle to OS object. Then you search for your function in dynamic library using its symbol. Symbol is just a unique name represented by a string of bytes. All public functions and static variables have unique symbol name. It is usually controlled by a compiler, but Rust allows you to set it explicitly using [`export_name`](https://doc.rust-lang.org/reference/abi.html#the-export_name-attribute) attribute:

```rust
#[unsafe(export_name = "my_function_symbol")]
pub fn my_function() {}
```

To load dynamic library in Rust there is a [`libloading`](https://crates.io/crates/libloading) crate that allows you to do it fairly easy:

```rust
use libloading::*;

let lib = Library::new("/path/to/liblibrary.so").unwrap();
let func: Symbol<unsafe extern "C" fn() -> u32> = lib.get(b"my_function").unwrap();
func(); // function loaded from dynamic library
```

To make your crate produce dynamic library instead of a object library you need to set crate type in `Cargo.toml` to either `dylib` or `cdylib`.:

```toml
[lib]
crate-type = ["dylib"]
# or
crate-type = ["cdylib"]
```

`dylib` is intended to be used by other Rust crates and uses unstable (as of now) Rust ABI. `cdylib` is intended to be used by other languages as it uses C ABI and produces libraries with smaller size because it strips Rust's metadata. For information about various crate types read about [Linkage](https://doc.rust-lang.org/reference/linkage.html) in the Rust reference.

## Reloading code with dynamic library

One of simplest ways of achieving hotreloading in Rust is to use dynamic libraries to update functions code. The idea is simple - instead of calling a statically linked function we load dynamic library and call a function from there instead. Then, after we change our code, we unload previously loaded library and reload updated version. It looks roughly something like that:

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

1. Loading and usage of dynamic library must be performed in a [binary](https://doc.rust-lang.org/cargo/reference/cargo-targets.html#binaries) or separate executable crate. `my_function` should be placed in a `dylib` crate because we will load our Rust library only from Rust, so there is no need to use `cdylib`.

2. Another dynamic library limitation is that you can not export functions with generics through them.

   <details>
    <summary>Why generics can not be exported in dynamic libraries?</summary>
    Because function's definition alone is not enough for compiler to generate real code, it also needs to know how exactly this function is used. For example, if we write:

    ```rust
     fn string_value<T: ToString>(t: &T) -> String {
         t.to_string()
     }

    string_value(&1);
    string_value("quo vadis");
    ```

    the compiler will generate two implementations of `string_value`: one for `i32` and one for `&str` because it uses static linking and knows all usage scenarios of `string_value`. When we build library for dynamic linking we can not know beforehand how our exported function will be used. One way to circumvent that is to use trait objects and dynamic dispatch:

    ```rust
    fn string_value(t: &dyn ToString) -> String {
       t.to_string();
    }
    ```
   </details>

Next we will focus on implementation details, specifically: 1. how to store dynamic library, 2. how to wait for dynamic library to update and 3. how to make it convenient to use.

## 1. Dynamic library storage

Dynamic library is represented in code as a `libloading::Library` struct - wrapper over handle to OS object. This handle must be kept alive while there are functions whose instructions are currently being read and executed in any thread. If you unload dynamic library while its function is in work you will get undefined behavior.

### Protection against in-use unload

To protect us from accidentally unloading dynamic library that is still in use we can store it in reference counted pointer and create function wrapper that keeps it. We will use `Arc` because dynamic libraries can be safely used from any thread:

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

// for ability call it like this:
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

Now when we call function loaded from dynamic library (that we get through `get_fn`) the guard will guarantee that there will be at least one reference to dynamic library until the function finishes execution. We no longer have to worry that library could be accidentally unloaded while it is still in use.

Next, let's try to make `get_fn` faster.

### Speeding-up functions search

Symbol look-up can be relatively costly operation. It performs syscall to retrieve address of provided symbol in loaded dynamic library's memory. Fortunately, its result can be cached because symbols in a dynamic library can not move. The first time we obtain their pointer, we can cache it in a symbol name map. We can create wrapper over `libloading::Library` that holds inner library, exposes `get_fn` method and keeps a cache of symbols pointers:

```rust
struct LibraryWrapper {
    inner: libloading::Library,
    symbols_map: RwLock<HashMap<&'static [u8], *mut core::ffi::c_void>>
}

impl LibraryWrapper {
    pub unsafe fn get_fn<F>(self: Arc<RwLock<Self>>, symbol_name: &'static [u8]) -> FnGuard<F> {
        let fn_ptr =
            if let Some(existing) = self.symbol_ptrs_map.read().unwrap().get(symbol_name) {
                existing
            } else {
                let raw_fn_ptr = self
                    .inner
                    .get::<fn()>(symbol_name)
                    .unwrap()
                    .try_as_raw_ptr()
                    .unwrap();
                self.symbol_ptrs_map
                    .write()
                    .unwrap()
                    .insert(symbol_name, raw_fn_ptr);
                raw_fn_ptr
            };
        let f = core::mem::transmute_copy(&fn_ptr.cast::<()>());
        let result = FnGuard { f, _lib_arc: lib.clone() };
        return result;
    }
}

// usage
let lib = LibraryWrapper::new(...); // same args as for `libloading::Library::new`
let f = lib.get_fn<fn() -> i32>(b"my_function_symbol");
f();
```

Now we can store dynamic library in a convenient `LibraryWrapper` structure that ensures library's lifetime and offers fast functions search.

## 2. Dynamic library update

We want our application to automatically reload dynamic library whenever we rebuild our library. To do it we need to watch for changes of our compiled dynamic library file. This can be done using [`notify`](https://crates.io/crates/notify) crate - it provides cross-platform file system watchers. Watcher lives in a separate thread and performs callback whenever target file receives specified changes: creation, deletion, modification and so on. Here's basic usage example:

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

The closure we passed will be called each time target file or any file in target directory is changed. We can run it to watch our dynamic library file and path `Arc` to closure, but we won't be able to reload our library because `Arc` does not allow mutating its contents.

Naive approach to solve it would be to store `Mutex` in `Arc` for ability to lock, unload and reload our library in watcher's callback.  
A better approach would be to use `RwLock`, since we mostly read from dynamic library - this happens each time we try to extract pointer to function from it using `get_fn` - and rarely write to it - only when we rebuild it.  
An even better approach would be to use `ArcSwap` struct from [`arc-swap`](https://crates.io/crates/arc-swap) crate. It stores an `Arc` that it can atomically change. It allows us to reload dynamic library without blocking at all!

Suppose we've called function `foo` from dynamic library. Then, while it's still executing, we receive notification from watcher that dynamic library has changed. We load new version library without unloading previous one because it is still in use by first call of `foo`. We store new version of dynamic library in our `ArcSwap` and any subsequent calls of `foo` will now use new version of this function. `Arc` to previous version of library was removed from `ArcSwap`, so it's no longer possible to call any function from previous library, but it will be still present in memory as long as first `foo` call is still running. The moment it is done, it's `FnGuard` will drop last `Arc` to previous library and it will automatically unload.

Together with file watcher our code will look like this:

```rust
// main - one time set up
let path = "path/to/dynamic/library";
let lib = Arc::new(ArcSwap::from_pointee(LibraryWrapper::new(path)));

let lib_for_callback = lib.clone();
let mut watcher = notify::recommended_watcher(|res| {
    let event = res.unwrap();
    if event.paths.contains(path) {
        let new_lib = LibraryWraper::new(path);
        lib_for_callback.store(Arc::new(new_lib));  // store new library
    }
}).unwrap();
watcher.watch(path, notify::RecursiveMode::NonRecursive).unwrap();

// usage
let func = lib
    .load_full()    // `ArcSwap` method
    .get<fn() -> i32>(b"my_function");
let result = func();
```

There is one last important thing that we must do - copy dynamic library file to some temp file so that `LibraryWrapper` instance won't hold lock on compileable file and block rebuilding. This can be easily tweaked in `LibraryWrapper`:

```rust
struct LibraryWrapper {
    inner: libloading::Library,
    symbols_map: RwLock<HashMap<&'static [u8], *mut core::ffi::c_void>>,
    lib_path: PathBuf   // adding this field to remember where library was loaded
                        // from (`libloading::Library` does not store it)
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
        std::fs::remove_file(&self.lib_path)
    }
}
```

Lastly, let's try to make this infrastructure easy to use.

## 3. Simplifying usage

As you can see right now we need to do a lot of things to hotreload functions. Initialize library, spawn watcher, manually load required functions before calling them, etc... However, all these steps can be replaced with a single macros attribute:

```rust
// what we are aiming for
#[hotreload]
fn foo() {}
```

First let's optimize library initialization and spawn watcher.

### Lazy dynamic library initialization

We can put dynamic library `LazyLock` in static variable and let library initialize itself the first time we need to call a function from it:

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
#[hotreload]    // procedural macros
fn my_function() {}

my_function();
```
So that we can call our hotreloadable functions without changing their callsites. To do it we need to enable both static and dynamic linking of our library crate, this can be done by using both `rlib` and `dylib` crate types in `Cargo.toml`:
```toml
[lib]
crate-type = ["rlib", "dylib"]
```
This will force Rust compiler to generate both `my_library.rlib` and `my_library.so` files. `.rlib` file contains object code (`.o`) and is used for static linking by LLVM and GCC byte-code compilers.

Then we need to modify source function with our macros so that it will load dynamic library when called statically and execute actual function instructions when called through dynamic library. We have two ways to do it using our `#[hotreload]` macro:
1. Generate two versions of our function: one will bear same name and be entrypoint for static calls that loads dynamic library, second will have actual function body and export name so that it can be loaded from dynamic library. This approach turns this:
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
   However, this would not work for functions inside trait implementations, because it creates new function that is not part of trait definition.
2. Add check for whether we're currently in statically or dynamically linked function inside each hotreloadable function. If we're inside statically linked function, then we need to load dynamic library and call it. If we're inside dynamically linked function, then we just execute actual functions instructions. This approach turns this:
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
   This approach can be used in any function because it does not change it's signature or creates new syntax items - it only modifies function's body. This allows it to be used even inside trait implementations, contrary to first approach:
   ```rust
   impl Trait for Struct {
       #[hotreload]
       fn work(&self) { self.do_something(); }
   }
   ```

Initially I used first approach in `hotcode`, but I was unsatisfied with the fact that this macros can't be used anywhere, so I came up with second option, that we will use today.

### Checking whether we are inside dynamic library

This check is the core component for our system. To perform it we need to ask OS information about current function's address space and map it to executable module name. If it matches `std::env::current_exe()`, then it means that we are inside statically linked function, otherwise - in dynamic library. Platform-agnostic pseudocode for this check looks something like this:
```rust
fn is_outside_dynamic_library() -> bool {
    let current_fn_ptr = is_outside_dynamic_library as *const _;
    let current_module_name = os::get_module_name_from_ptr(current_fn_ptr);
    return current_module_name != std::env::current_exe();
}
```
Notice that we do not need to pass pointer to function that we're trying to hotreload - the `is_outside_dynamic_library`'s pointer is enough to determine whether current module name, because it will also exist in two variants - as a staticaly and dynamically linked function.

On Linux `get_module_name_from_ptr` uses `dladdr` OS function, on Windows - `GetModuleHandleExW` and `GetModuleFileNameW` OS functions. As most of syscalls these functions can be slow, and performing this check for each hotreloadable function call can be inexcussable on hotpaths. Fortunately, result of this function can also be cached! We can define static lazy bool variable and cache check result in it:
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

This works because each dynamic library has it's own set of static variables. This means that in our host process that calls hotreloadable functions the `IS_OUTSIDE_DYNAMIC_LIBRARY` will cache to `false`, and in dynamic libraries that we load it will cache to `true`. We can safely cache it once and never rerun this check afterwards because function can not move inside process memory. This way overhead for calling hotreloadable functions becomes neglegible.

### Result

Now all we have to do to make a function hotreloadable is to apply `#[hotreload]` attribute. That's it!
```rust
#[hotreload]
fn my_function() {}

impl Struct {
    fn my_function(&self) {}
    fn my_static_function() {}
}

impl Trait for Struct {
    fn my_function(&self) {}
    fn my_static_function() {}
}
// and any other function that you may find
```

Regarding performance, in the worst case we'll have to do two relatively-slow initializations: loading library from disk, calling OS function to check if we're inside dynamic library, and search for required function in loaded dynamic library. In the best case we load values from two `LazyLock`s and extract existing entry from `HashMap`.

### Supporting multiple libraries

TODO
we need to change `LazyLock<Arc<ArcSwap<LibraryWrapper>>>` to `LazyLock<HashMap<String, Arc<ArcSwap<LibraryWrapper>>>>`
```rust
static DYNAMIC_LIBRARY: LazyLock<Arc<ArcSwap<LibraryWrapper>>> =
    LazyLock::new(initialize_dynamic_library);
```

## Conclusion

TODO
1. single-attribute solution
2. cunning caching
3. cunning dynamic library lifetime management
