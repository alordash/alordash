# Hot Reload in Rust

Sometimes during development you may face a problem that could be solved in different ways. You may not know which approach is best, so you start testing all of them. You use one approach, run your program, check results, switch to next approach, rerun your program, check results again, maybe tweak a couple of scalar values and repeat until you get satisfying result. But with each iteration you lose your time to things like program start-up and reproduction of testing environment.

To speed-up iterations and reduce amount of wasted time there is a technique called "hot reload". It lets you change the code of already running application. This does not only remove the need to restart program after every change, but also keeps the state of program in-tact, so you don't need to go through the chores of things like DB connection or openning and editing test file again.

I'd like to tell how this technique can be implemented and (almost) painlessly used in Rust with the power of dynamic libraries.

## A Dynamic Library

> _This section contains short description of what a dynamic library is and how it works. If you already know it you can skip this part._

Dynamic library is a collection of precompiled code represented by a file on disk. It's code can be loaded at run-time by your application using special OS functions. You give the path to dynamic library file to OS and it loads it into your process' memory, returning you a handle. Then, usually through the OS, you search for the needed function in this dynamic library in your memory using its symbol. Symbol is just a unique name represented by a string of bytes. All public functions and static variables have unique symbol name. Symbol name is usually controlled by a compiler, but Rust allows you to set it explicitly using [`export_name`](https://doc.rust-lang.org/reference/abi.html#the-export_name-attribute) attribute:

```rust
#[unsafe(export_name = "my_function_symbol")]
pub fn my_function() {}
```

To load dynamic library in Rust there is a [`libloading`](https://crates.io/crates/libloading) crate that allows you to do it farely easy:

```rust
use libloading::*;

let lib = Library::new("/path/to/liblibrary.so").unwrap();
let func: Symbol<unsafe extern "C" fn() -> u32> = lib.get(b"my_func").unwrap();
func(); // call function loaded from dynamic library
```

Functions called from dynamic libraries have virtually no overhead, as they are invoked the same way as any other statically linked function.

## How to reload code with dynamic library

One of simplest ways of achieving hot-reloading in Rust is to use dynamic libraries to update functions code. The idea is simple - instead of calling a statically linked function we load dynamic library and call dynamically linked function instead. Then, after we change our code, we will previously loaded library and load updated version.
