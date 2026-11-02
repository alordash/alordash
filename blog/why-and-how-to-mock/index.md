# Why and How to Mock

Mocking is an approach that makes writing unit tests easier. It hides implementation details of functions called by the method for which you are currently writing tests. This allows creating stable and simple unit tests, while also indulging writing clean code. Because if you can't mock your dependencies or their setup takes more effort than the test itself, your code is probably coupled too tight with functions that have no clear responsibility.

Today I want to show why it's important to mock your functions in unit tests and how to do it in Rust painlessly. This post consists of two parts: why you should mock and how to mock in Rust.

First part is about how mocks simplify tests writing and implicitly force you to write better structured code. And although code examples there are written in Rust, the principles we will discuss can be applied in any programming language that has mature mocking library.

Second part is about how to write such mocking library in Rust and how behind the scenes of mocking frameworks looks like. Some of its ideas can be used in other programming languages, but it mostly aims at Rust.

## Why Mock

In my opinion there are three reasons for mocking your code in unit tests:
1. mocks increase tests stability because they shield your logic from having to deal with network, file system, OS handles and other unstable things;
2. they can reduce number of test cases (due to combinatorical explosion);
3. they force you to write clean code because it is easier to test and mock the function that does one thing than the function that does a lot of things.

### Mocks increase tests stability
Lets first write a test for a simple function that calculates how much user must pay for a given quantity of some product. It receives a number - the quantity of bought product, and returns price that it reads, for simplicity, from the file on the disk.

```rust
pub fn calculate_price(quantity: u32) -> u32 {
    let single_item_price = get_price();
    return quantity * single_item_price;
}

fn get_price() -> u32 {
    fs::read_to_string("price.txt").unwrap().parse().unwrap()
}
```

> In real world instead of a single number this function could receive a map of product types and their bought quantities, and price of products would be read from DB instead of a file, but that doesn't change the overall shape of the function much.

Now let's write test for it. The way it's currently written you will have to create real file so that `get_price` can read and parse its content:
```rust
// Arrange
let quantity = 2;
let price = 10;
fs::write("price.txt", price.to_string());

// Act
let result = calculate_price(quantity);

// Assert
assert_eq!(result, quantity * price);
```

This is, of course, very inconvenient, because:
1. You are arranging file to test a function that doesn't touch file itself - all it does is get the price from some `get_price()` function.
2. Now you have `price.txt` file on your disk that you forgot to clean. Or you didn't, but maybe your disk is full, or maybe test's process doesn't have rights to write this file, or maybe another process rewrote this file before you called `get_price()`. This all produces test failures that are irrelevant to the code that we actually want to test - the body of `calculate_price`.
  > If price was read from DB then you'd have to setup a whole test DB just for this one small test.
3. You are depending on `get_price()` implementation. What if someone from your team changes it, for example, by replacing `price.txt` with `current_price.txt`? The test will fail for irrelevant reason again.

That's where the mocks come to the rescue: instead of depending on `get_price`'s implementation, you set its behavior in test yourself:
```rust
#[mock]                     // magic attribute that makes our function mockable, more about
fn get_price() -> u32 {     // this specific attribute is in the second part of the post
    fs::read_to_string("price.txt").unwrap().parse().unwrap()
}

// Arrange
let quantity = 2;
let price = 10;
get_price::setup().returns(price);  //  make `get_price` return `price` value

// Act
let result = calculate_price(quantity);

// Assert
assert_eq!(result, quantity * price);
get_price::verify_calls();  // also verify that we actually used `get_price` and didn't
                            // get price from somewhere else that just by fortune
                            // happened to be the same as the `price` value
```

Now this test tests only `calculate_price` implementation. It no longer cares how exactly price is received and is no longer prone to flaky errors related to file system.

### Mocks reduce number of test cases
