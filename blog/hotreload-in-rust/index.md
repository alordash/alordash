# Hotreload in Rust

Hotreloading lets you change the code of a running application. This removes the need to restart the program after every change. It also keeps the state of a program in-tact, so you don’t need to go through the chores of things like connecting to DB, openning and editing test file, or arranging dummies for a car crash simulation in your physics engine again.

Today I'd like to tell you how to painlessly hotreload Rust code and how I've done it in my [`hotcode`](https://crates.io/crates/hotcode) crate. We will need to use dynamic libraries for this.

## A Dynamic Library

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
let func: Symbol<unsafe extern "C" fn() -> u32> = lib.get(b"my_function_symbol").unwrap();
func(); // function loaded from dynamic library
```

Calling a function from dynamic library has virtually no overhead, as it is invoked the same way as any other statically linked function.

## Reloading code with dynamic library

One of simplest ways of achieving hotreloading in Rust is to use dynamic libraries to update functions code. The idea is simple - instead of calling a statically linked function we load dynamic library and call a function from there instead. Then, after we change our code, we unload previously loaded library and reload updated version. Conceptually, it looks something like that:

```rust
let lib = libloading::Library::new(...);
let func = lib.get<fn() -> i32>(...);

let first_result = func();

// ...
// wait for dynamic library to update
// ...

drop(lib); // unload previous dynamic library
let lib = libloading::Library::new(...);
let func = lib.get<fn() -> i32>(...);

let second_result = func(); // use changed function

assert_ne!(first_result, second_result);
```

This is basically the whole idea. Now we will focus on its details. We need to answer following questions: 1. how to store dynamic library, 2. how to wait for dynamic library to update and 3. how to make it convenient to use.

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
            // first lock map only for reading to try to find cached pointer
            if let Some(existing) = self.symbol_ptrs_map.read().unwrap().get(symbol_name) {
                existing.clone()
            } else {
                // otherwise search it via syscall and cache it through "write" lock
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

> <details>
>  <summary>Why generics can not be used in dynamic libraries?</summary>
>
>  Because function's definition alone is not enough for compiler to generate real code, it also needs to know how exactly this function is used. For example, if we write:
>  ```rust
>   fn string_value<T: ToString>(t: &T) -> String {
>       t.to_string()
>   }
>  
>  string_value(&1);
>  string_value("quo vadis");
>  ```
>  the compiler will generate two implementations of `string_value`: one for `i32` and one for `&str` because it uses static linking and knows all usage scenarios of `string_value`. When we build library for dynamic linking we can not know beforehand how our exported function will be used. One way to circumvent that is to use trait objects and dynamic dispatch:
>  ```rust
>  fn string_value(t: &dyn ToString) -> String {
>     t.to_string();
>  }
>  ```
></details>

## 2. Catching dynamic library updates
