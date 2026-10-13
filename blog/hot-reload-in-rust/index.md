# Hot Reload in Rust

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

One of simplest ways of achieving hot-reloading in Rust is to use dynamic libraries to update functions code. The idea is simple - instead of calling a statically linked function we load dynamic library and call a function from there instead. Then, after we change our code, we unload previously loaded library and reload updated version. Conceptually, it looks something like that:

```rust
let lib = todo!("load dynamic library");
let func = todo!("find our function");

let first_result = func();

// ...
// wait for dynamic library to update
// ...

drop(lib); // unload previous dynamic library
let lib = todo!("reload dynamic library");
let func = todo!("find our function again");

let second_result = func(); // use changed function

assert_ne!(first_result, second_result);
```

This is the core idea. Now we will focus on details, specifically we need to answer following questions: 1. how to store dynamic library, 2. how to wait for dynamic library to update and 3. how to make it convenient to use.

## Dynamic library(ies) storage
