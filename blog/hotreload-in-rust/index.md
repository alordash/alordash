# Hotreload in Rust

Hotreloading lets you change the code of a running application without restarting it after every change. It also preserves the program's state, so you don't have to repeat setup tasks such as connecting to DB, opening and editing test files, or arranging cars for a crash simulation in your physics engine.

Today, I'd like to show you how to hotreload Rust code using dynamic libraries, and explain how I implemented it in my [`hotcode`](https://crates.io/crates/hotcode) crate.

## Table of Contents

- [Dynamic Libraries](#dynamic-libraries)
- [Reloading Code with Dynamic Library](#reloading-code-with-dynamic-library)
- [Dynamic Library Storage](#dynamic-library-storage)
  - [Protection against in-use unload](#protection-against-in-use-unload)
  - [Faster function search](#faster-function-search)
- [Dynamic Library Update](#dynamic-library-update)
- [Simplifying Usage](#simplifying-usage)
  - [Lazy dynamic library initialization](#lazy-dynamic-library-initialization)
  - [Checking whether we are inside dynamic library](#checking-whether-we-are-inside-dynamic-library)
  - [Supporting multiple libraries](#supporting-multiple-libraries)
  - [Result](#result)
- [Conclusion and Acknowledgements](#conclusion-and-acknowledgements)

## Dynamic Libraries

> _This section briefly explains what a dynamic library is and how it works. If you're already know it you can skip this part._

A dynamic library is a collection of precompiled code represented by a file on disk. Its code can be loaded at run-time by your application using special OS functions. You give the path to a dynamic library file to the OS and it loads it into your process's memory, returning a handle to an OS object. Then you search for your function in dynamic library using its symbol. A symbol is just a unique name represented by a string of bytes. Rust allows you to set it explicitly using [`export_name`](https://doc.rust-lang.org/reference/abi.html#the-export_name-attribute) attribute:

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

To make your crate produce a dynamic library, set its crate type in `Cargo.toml` to either `dylib` or `cdylib`:

```toml
[lib]
crate-type = ["dylib"]
# or
crate-type = ["cdylib"]
```

`dylib` is intended for use by other Rust crates and uses Rust's (currently) unstable ABI. `cdylib` is intended for use by foreign languages and produces smaller libraries because it strips Rust metadata. For more information about crate types, you can read about [Linkage](https://doc.rust-lang.org/reference/linkage.html) in the Rust Reference.

## Reloading Code with Dynamic Library

One of the simplest ways to perform hotreload in Rust is to use dynamic libraries to update a function's code. The idea is simple: instead of calling a statically linked function, we load a dynamic library and call a function from it. After changing the code, we unload the old library and load the updated version. It looks roughly like this:

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

That's the basic idea, but there are some limitations:

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

   the compiler will generate two implementations of `string_value`: one for `i32` and one for `&str`. Because it uses static linking, it knows all ways `string_value` is used. When building a dynamically linked library, however, we can't know in advance how an exported function will be used. One workaround is to use trait objects and dynamic dispatch:

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

Next, we will focus on implementation details: 1. how to store a dynamic library, 2. detect when it changes, and 3. make it convenient to use.

## Dynamic Library Storage

In code, a dynamic library is represented by a `libloading::Library` struct, which wraps a handle to an OS object. This handle must remain alive while any thread is executing code from the library. Unloading a library while one of its functions is running causes undefined behavior.

### Protection against in-use unload

To avoid accidentally unloading a library that's still in use, we can store it in a reference-counted pointer and create a function wrapper that keeps the library alive. We'll use `Arc` because the library may be accessed from multiple threads:

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

When we call a function loaded from a dynamic library through `get_fn`, the guard ensures that at least one reference to the library remains alive until the function call finishes. This prevents the library from being unloaded while it's still in use.

Next, let's try to make `get_fn` faster.

### Faster function search

Symbol lookup can be relatively expensive. Fortunately, its result can be cached because a symbol's address in a loaded dynamic library doesn't change. The first time we obtain a pointer to a symbol, we can cache it in a map keyed by the symbol name. We can create a wrapper around `libloading::Library` that owns the library, exposes a `get_fn` method, and caches symbol pointers:

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

Now we can store a dynamic library in a convenient `LibraryWrapper` structure that keeps the library alive and offers fast function search.

## Dynamic Library Update

We want our application to reload dynamic library automatically whenever we rebuild it. To do this, we need to watch the compiled library file for changes. This can be done using the [`notify`](https://crates.io/crates/notify) crate provides cross-platform filesystem watchers. A watcher runs in a separate thread and invokes a callback when target file changes - for example, when it's created, deleted, or modified. Here's a basic example:

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

The closure is called whenever target file or any file in watched directory changes. You may need to use debounced watcher [`notify-debouncer-full`](https://crates.io/crates/notify-debouncer-full), because Cargo may write the file multiple times, but for the sake of simplicity we will use the regular version. We can run it to watch our dynamic library file and pass an `Arc` to the callback, but `Arc` alone doesn't let us mutate our library.

A naive solution would be to put a `Mutex` inside an `Arc`, allowing the watcher's callback to lock the value, unload the old library, and load the new one.  
A better solution would be to use `RwLock`, since we read from the library frequently - whenever we use `get_fn` to obtain a function pointer - but update it only when the library is rebuilt.  
An even better solution is to use `ArcSwap` from [`arc-swap`](https://crates.io/crates/arc-swap) crate. It stores an `Arc` that can be replaced atomically, allowing us to reload a library without blocking at all!

It works like this: suppose we've called `foo` from a dynamic library. While it's still running, the watcher reports that the library has changed. We load new version without unloading the old one, since first call to `foo` is still using it. We then store new library in `ArcSwap`, so subsequent calls to `foo` use new version. The old library's `Arc` is removed from `ArcSwap`, preventing new calls from using old version of the function, but the library remains loaded while first call is still running. Once that call finishes, its `FnGuard` drops last `Arc` to the old library, and it automatically unloads.

Combined with the file watcher, the code looks like this:

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

There's one last important step: copy dynamic library to a temporary file so that `LibraryWrapper` doesn't keep build output locked. We can implement this in `LibraryWrapper::new`:

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

Finally, let's make this infrastructure easier to use.

## Simplifying Usage

As you can see, hotreloading functions currently requires several steps: initializing library, spawning watcher, manually loading functions before calling them, and so on. We can replace all of this with a single attribute macro:

```rust
// what we are aiming for
#[hotreload]
fn foo() {}
```

First, let's simplify library initialization and watcher setup.

### Lazy dynamic library initialization

We can store dynamic library behind a `LazyLock` in a static variable, initializing it first time we call one of its functions:

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
This lets us call hotreloadable functions without changing their call sites. To do it we need to enable both static and dynamic linking of our library crate; this can be done by using both `rlib` and `dylib` crate types in `Cargo.toml`:
```toml
[lib]
crate-type = ["rlib", "dylib"]
```
This tells the Rust compiler to generate both `my_library.rlib` and `my_library.so`. The `.rlib` file contains object code (`.o`) and Rust metadata, and is used to statically link the library so its functions can be called directly from the executable.

Next, our macro needs to transform source function so that calls from statically linked code load dynamic library, while calls through dynamic library execute function's actual body. We can implement this in two ways with `#[hotreload]` macro:
1. Generate two versions of our function: one will bear same name and be an entrypoint for static calls that loads dynamic library; second will have actual function body and export name so that it can be loaded from dynamic library. This approach turns this:
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
   However, this approach doesn't work for functions inside trait implementations because it creates a new function that isn't part of the trait implementation.
2. Add a check for whether we're currently in a statically or dynamically linked function inside each hotreloadable function. If we're inside a statically linked function, then we need to load dynamic library and call it. If we're inside a dynamically linked function, then we just execute actual function's instructions. This approach turns this:
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
   This approach works with any function because it doesn't change function's signature or create new syntax items; it only modifies function body. Unlike the first approach, it can therefore also be used inside trait implementations:
   ```rust
   impl Trait for Struct {
       #[hotreload]
       fn work(&self) { self.do_something(); }
   }
   ```

I initially used the first approach in `hotcode`, but I wasn't satisfied that the macro couldn't be used everywhere. So I came up with the second approach, which we'll use here.

### Checking whether we are inside dynamic library

This check is core of our system. We need to ask OS which module contains current function's address, then compare that module's path with `std::env::current_exe()`. If they match, we're in a statically linked function; otherwise, we're in dynamic library. Platform-agnostic pseudocode for this check looks like this:
```rust
fn is_outside_dynamic_library() -> bool {
    let current_fn_ptr = is_outside_dynamic_library as *const _;
    let current_module_name = os::get_module_name_from_ptr(current_fn_ptr);
    return current_module_name != std::env::current_exe();
}
```
Notice that we don't need to pass a pointer to the function we're trying to hotreload. The pointer to `is_outside_dynamic_library` is enough to determine the current module, because that function also exists in two versions: one statically linked and one dynamically linked.

On Linux, `get_module_name_from_ptr` uses the libc function `dladdr`. On Windows, it uses OS functions `GetModuleHandleExW` and `GetModuleFileNameW`. Performing this check on every hotreloadable function call could be too expensive on hot paths. Fortunately, we can cache result in a lazily initialized static `bool`:
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

This works because each dynamic library has its own set of static variables. In the host process, which calls the hotreloadable functions, `IS_OUTSIDE_DYNAMIC_LIBRARY` caches `false`; in each loaded dynamic library, it caches `true`. We can cache result permanently because function's address won't move within the process's memory. As a result, overhead of calling hotreloadable functions becomes negligible.

### Supporting multiple libraries

There's one more improvement we can make. Suppose your binary uses multiple libraries whose functions you want to hotreload. The current implementation will panic when unwrapping the result of `libloading::Library::get_fn` if you try to load a function from a second library after the first library has initialized static `DYNAMIC_LIBRARY` variable. We can solve this by storing an `RwLock<HashMap<String, Arc<ArcSwap<LibraryWrapper>>>>` in `DYNAMIC_LIBRARY`, using the map to associate each library with its `LibraryWrapper`:

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

We can also get the name of the crate where `#[hotreload]` is used from the `CARGO_PKG_NAME` environment variable: `std::env::var("CARGO_PKG_NAME").unwrap()`. We can pass this name instead of hard-coded `"your_library_name.so"`.

### Result

Now, to make a function hotreloadable, all we have to do is apply the `#[hotreload]` attribute:
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

We haven't sacrificed much performance, either. In the worst case, we perform three relatively expensive operations: loading the library from disk, calling an OS function to check whether we're inside dynamic library, and looking up the required function in the loaded library. In the best case, we read values from two `LazyLock`s and retrieve an existing entry from a `HashMap`.

You can see benchmark results in `hotcode`'s [documentation](https://docs.rs/hotcode/1.0.2/hotcode/#benchmarks).

Keep in mind that this approach is not limited to Rust - hotreloading can be implemented in any programming language that can compile to and load dynamic library. That said, Rust's type system and memory model made this project significantly easier to develop.

## Conclusion and Acknowledgements

This was a fun project, but it's not first attempt to bring hotreloading to Rust. Here are a few other approaches I found interesting:

1. [`hot-lib-reloader`](https://crates.io/crates/hot-lib-reloader) - this crate also uses dynamic libraries for hotreloading, but requires a lot more configuration.
2. [`subsecond`](https://crates.io/crates/subsecond) - solution by the Dioxus team that uses hotpatching and custom linker. Requires Dioxus CLI and wrapping hotreloadable code in `subsecond::call`.
3. [`inline_tweak`](https://crates.io/crates/inline_tweak) - zero-dependency solution that hotreloads literal values. Easy to use with a single macro.

That's it for now. I hope this helps you shorten your iteration cycles!

> __Link to `hotcode` source repository__ - https://github.com/alordash/hotcode
