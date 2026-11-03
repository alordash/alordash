# Why and How to Mock

Mocking is an approach that makes writing unit tests easier. It hides implementation details of functions called by the method for which you are currently writing tests. This allows creating stable and simple unit tests, while also indulging writing clean code. Because if you can't mock your dependencies or their setup takes more effort than the test itself, your code is probably coupled too tight with functions that have no clear responsibility.

Today I want to show why it's important to mock your functions in unit tests and how to do it in Rust painlessly. This post consists of two parts: why you should mock and how to mock in Rust.

First part is about how mocks simplify tests writing and implicitly force you to write better structured code. And although code examples there are written in Rust, the principles we will discuss can be applied in any programming language that has mature mocking library.

Second part is about how to write such mocking library in Rust and how behind the scenes of mocking frameworks looks like. Some of its ideas can be used in other programming languages, but it mostly aims at Rust.

## Why Mock

In my opinion there are three reasons for mocking your code in unit tests:

1. mocks increase tests stability because they shield your logic from having to deal with network, file system, OS handles and other unstable things,
2. they can reduce number of test cases (due to combinatorical explosion),
3. they force you to write clean code because it is easier to test and mock the function that does one thing than the function that does a lot of things.

### Mocks increase tests stability

Lets first write a test for a simple function that calculates how much user must pay for a given quantity of some product. It receives a number - the quantity of bought product, and returns price that it reads, for simplicity, from the file on the disk.

```rust
pub fn calculate_price(quantity: u32) -> u32 {
    let single_item_price = get_price();
    return quantity * single_item_price;
}

fn get_price() -> u32 {
    return fs::read_to_string("price.txt").unwrap().parse().unwrap();
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
2. Now you have `price.txt` file on your disk that you forgot to clean. Or you didn't, but maybe your disk is full, or maybe test's process doesn't have rights to write this file, or maybe another process rewrote this file before you called `get_price()`. And that's just the first `unwrap`, this function can also fail because the value inside file is not a valid number string. All of this produces test failures that are irrelevant to the code that we actually want to test - the body of `calculate_price`.

> If price was read from DB then you'd have to setup a whole test DB just for this one small test.

3. You are depending on `get_price()` implementation. What if someone from your team changes it, for example, by replacing `price.txt` with `current_price.txt`? The test will fail for irrelevant reason again.)

That's where the mocks come to the rescue: instead of depending on `get_price`'s implementation, you set its behavior in test yourself:

```rust
#[mock]                     // magic attribute that makes our function mockable, more about
fn get_price() -> u32 {     // this specific attribute is in the second part of the post
    return fs::read_to_string("price.txt").unwrap().parse().unwrap();
}

// Arrange
let quantity = 2;
let price = 10;
get_price::setup().returns(price);  //  make `get_price` return `price` value

// Act
let result = calculate_price(quantity);

// Assert
assert_eq!(result, quantity * price);
get_price::verify_calls();  // this function checks that mocked behavior that
                            // we set up during arrangement was actually called
```

Now this test tests only `calculate_price` implementation. It no longer cares how exactly price is received and is no longer prone to flaky errors related to file system.

### Mocks reduce the number of test cases

Lets write a simple function that calculate number of vacation days of employee based on his contract type and position. Major part of these days depends on contract types and position can give few bonus days:

```rust
pub enum Contract { FullTime, PartTime }
pub enum Position { Junior, Middle, Senior }

pub fn vacation_days(contract: Contract, position: Position) -> u32 {
    let base_days = match contract {
        Contract::FullTime => 20,
        Contract::PartTime => 10,
    };
    let bonus_days = match position {
        Position::Junior => 0,
        Position::Middle => 2,
        Position::Senior => 5,
    };
    return base_days + bonus_days;
}
```

Now let's write tests:

```rust
fn vacation_days_test(contract: Contract, position: Position, expected_days: u32) {
    // Act
    let actual_days = vacation_days(contract, position);

    // Assert
    assert_eq!(actual_days, expected_days);
}

#[test]
fn vacation_days_ok() {
    test(Contract::FullTime, Position::Junior, 20);
    test(Contract::FullTime, Position::Middle, 22);
    test(Contract::FullTime, Position::Senior, 25);
    test(Contract::PartTime, Position::Junior, 10);
    test(Contract::PartTime, Position::Middle, 12);
    test(Contract::PartTime, Position::Senior, 15);

    fn test(contract: Contract, position: Position, expected_days: u32) {
        // Act
        let actual_days = vacation_days(contract, position);
    
        // Assert
        assert_eq!(actual_days, expected_days);
    }
}
```

As you can see number of tests is equal to the product of number of possible values of each argument, which in this case is `2 (Contract) x 3 (Position) = 6`. With current implementation number of unit tests will grow very quickly with each new input argument option. For example, if we introduce new `Contract` then the number of tests will be increased by `3` (need to test all existing `Position`s with this new contract). Or if we add new rule that says that employees that worked for more than 2 years get 5 more vacation days, we will have `12` more test cases (all existing test cases multiplied by two cases: when employee worked less than or equal to 2 years and when more).

Better way to test this function is to split days calculation logic into separate functions because none of the arguments affects number of days provided by other arguments: doesn't matter if you are junior or middle, on full-time contract you will always get 20 base days.

```rust
pub fn vacation_days(contract: Contract, position: Position) -> u32 {
    return contract_vacation_days(contract) + position_vacation_days(position);
}

#[mock]
fn contract_vacation_days(contract: Contract) -> u32 {
    match contract {
        Contract::FullTime => 20,
        Contract::PartTime => 10,
    }
}

#[mock]
fn position_vacation_days(position: Position) -> u32 {
    match position {
        Position::Junior => 0,
        Position::Middle => 2,
        Position::Senior => 5,
    }
}
```

This way we need to test just two things: that `vacation_days` calls `contract_vacation_days` and `position_vacation_days` functions and that their logic is correct:

```rust
#[test]
fn vacation_days_ok() {
    // Arrange
    let contract = Contract::Whatever;  // for this test we don't care what exactly `contract`
    let contract_days = 1;              // is and how many vacation days it gives, we just need
    let position = Position::Whatever;  // to make sure that we use `contract_vacation_days` and
    let position_days = 2;              // `position_vacation_days` correctly
    contract_vacation_days::setup(contract).returns(contract_days);
    position_vacation_days::setup(position).returns(position_days);

    // Act
    let result = vacation_days(contract, position);

    // Assert
    assert_eq!(result, contract_days + position_days);  // testing only `vacation_days` logic
    contract_vacation_days.verify_calls();
    position_vacation_days.verify_calls();
}

#[test]
fn contract_vacation_days_ok() {
    test(Contract::FullTime, 20);
    test(Contract::PartTime, 10);
    
    fn test(contract: Contract, expected_days: u32) {
        // Act
        let actual_days = contract_vacation_days(contract);
    
        // Assert
        assert_eq!(actual_days, expected_days);
    }
}

#[test]
fn position_vacation_days_ok() {
    test(Position::Junior, 0);
    test(Position::Middle, 2);
    test(Position::Senior, 5);
    
    fn test(position: Position, expected_days: u32) {
        // Act
        let actual_days = position_vacation_days(position);
    
        // Assert
        assert_eq!(actual_days, expected_days);
    }
}
```

We still have same 6 tests, but if we add new `Contract` we would have 7 tests with mocks and 9 without them. The formula for number of tests is actually quite simple: without mocks it is product of number of possible argument values, with mocks it is their sum + 1, because we need a test for `vacation_days` function that aggregates results from split functions. This way we moved number of tests from geometrical to arithmetical progression.

### Mocks force you to write clean code

Consider following small function that checks whether it is cold in a given city. It performs http request to weather service and checks whether returned temperature is below zero.
```rust
pub fn is_it_cold(city: &str) -> bool {
    let url = format!("https://api.weather.example/temp?city={city}");
    let body = http::get(&url).unwrap();
    let temperature: f64 = body.trim().parse().unwrap();
    return temperature < 0.0;
}
```

Seems very simple, right? But this function actually performs 4 different steps:
1. format url,
2. perform http request,
3. parse response body as f64,
4. check temperature.

If you want to test this function, you will have to write unit tests for all of them. Also, you will need to deploy a real weather api server, because you cannot mock `http::get` function.

All this pain of writing tests would go away if we refactor our code to be more clean. The main problem is that the process of city's temperature retrieval is inlined in the function. I think it is complex enough that it deserves it's separate function. This both makes our function cleaner and mockable:

```rust
pub fn is_it_cold(city: &str) -> bool {
    let temperature = get_temperature(city);
    return temperature < 0.0;
}

#[mock]
fn get_temperature(city: &str) -> f64 {
    let url = format!("https://api.weather.example/temp?city={city}");
    let body = http::get(&url).unwrap();
    return body.trim().parse().unwrap();
}
```

And then it becomes very easy to write tests:

```rust
fn temp_is_negative_returns_true() {
    // Arrange
    let city = "macondo";
    get_temperature::setup(city).returns(-1.0);

    // Act
    let result = is_it_cold(city);

    // Assert
    assert!(result);
    get_temperature::verify_calls();
}

fn temp_is_zero_or_positive_returns_false() {
    test(0);
    test(1);
    
    fn test(temperature: u64) {
        // Arrange
        let city = "macondo";
        get_temperature::setup(city).returns(temperature);

        // Act
        let result = is_it_cold(city);

        // Assert
        assert!(!result);
        get_temperature::verify_calls();
    }
}
```

All that's left to do is to write one or two integrations tests for `get_temperature` function that perform real calls.

## Conclusion

Inability to mock functions hints at badly structured code.

Functions that interact with an outer world (I/O, systems integrations, etc) will always be unstable, mocking outer world is the only solution to have deterministic tests.
