# Creating mocking library in Rust

I was working on one of my pet projects the other day and I decided to write some unit tests. I had a struct that looked something like this:

```rust
impl Worker {
    fn work_core(&self) {
        return 1;
    }
}

impl IWorker for Worker {
    pub fn work(&self) -> i32 {
        return self.work_core() + 2;
    }
}
```

`work_core` was some business logic function that's closed enough to be moved to separate method, but too specific to `Worker` to be moved to some other struct. I decided to write two separate unit-tests: one for `work_core` and one for `work`. `work_core`'s test should just check that function returns `1`, and `work`'s should just check that it returns whatever `work_core` returns + 2.

I started searching for Rust crate that would allow me configure `Worker` for these two tests, but, unfortunately, I found out that there are no crates that can do it. I checked [`mockall`](https://crates.io/crates/mockall), [`mockito`](https://crates.io/crates/mockito), [`faux`](https://crates.io/crates/faux) and many other less known crates; none of them had required functionality.

However, I really did not want to turn two simple and sleek unit-tests

```rust
#[test]
fn work_core_ok() {
    // Act
    let result = Worker.work_core();
    // Assert
    assert_eq!(result, 1);
}

#[test]
fn work_ok() {
    // Arrange
    let worker = Worker;
    let work_core_result = 10;
    worker.setup().work_core().returns(work_core_result);

    // Act
    let result = worker.work();

    // Assert
    assert_eq!(result, work_core_result + 2);
    worker.verify_calls();  // check that `Worker.work` was called
}
```

into one test that checks both `work` and `work_core` and looks more integrational than unit:

```rust
#[test]
fn work_ok() {
    // Act
    let result = worker.work();

    // Act
    assert_eq!(result, 3);
}
```

I don't like such tests for few reasons, which I described in [`Why mock`](../why-mock) post. So, I thought why not try to write mocking library myself? After all, it's a pet project and I have no deadlines, why not switch focus to something different? Besides, I always wondered how such libraries work under the bonnet. And so I started working on custom mocking library.

This is backstory of how I created [`automock`](https://crates.io/crates/automock) - crate for mocking that has all features that I missed to write good unit-tests in Rust. You can read about it more in its documentation, what and how it can and can't, but here we're going to focus on how it was created.

## Table of Contents