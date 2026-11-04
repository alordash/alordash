# How to Mock (in Rust)

The question in the title is not about how you should mock dependencies in your unit tests code, but how to create a library that allows you to make any function/struct/trait mockable with a single `#[mock]` attribute:

```rust
#[mock] // magic ✨ that we'll create
fn work(i: i32) -> i32 { i + 1 }

// Arrange
work::setup(10).returns_once(20);

// Act
let result = work(10);

// Assert
assert_eq!(result, 20);
work::verify_calls();
```
