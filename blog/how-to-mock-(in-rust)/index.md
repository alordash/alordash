# How to Mock

*(in Rust)*

Mocking is an approach that makes writing unit tests easier. It hides implementation details of functions called by the method for which you are currently writing tests.

It works this way: suppose that have a function that reads contents of a file and filters out blank lines:

```rust
fn read_file(path: Path) -> Result<String> {
    fs::read_to_string(path).unwrap()
}

pub fn read_file_lines(path: Path) -> Vec<String> {
    let file_content = read_file(path);
    let lines: Vec<String> = file_content
        .lines()
        .filter(|line| !line.is_empty())
        .collect();
    return lines;
}
```

Now, if you want to write unit test for `read_file_lines`, you will have to actually create file so that `read_file` can read its content:
```rust
// Arrange
let string = "first line\n\nthird_line";
fs::write("temp_file.txt", string);

// Act
let result = read_file_lines("temp_file.txt");

// Assert
assert_eq!(result, vec!["first line", "third line"]);
```

This is of course very inconvenient, because:
1. You are arranging stuff that's completely irrelevant to what your function does - who cares what the file contents are? The function does one job - it gets string from some `read_file`, splits, filters it and returns the result, it doesn't touch anything related to file system in the slightest.
2. Now you have `temp_file.txt` on your disk that you forgot to clean. Or you didn't, but maybe your disk is full and now your test fails because of it (instead of actually testing the function's behavior). Or maybe test process doesn't have rights to write file to the specified path. Or maybe another process rewrote this file before you could read it and now your test fails (again for irrelevant reason). One big minefield!
3. You are depending on `read_file` implementation. What if someone changes it, for example, to return an error if given file doesn't have `.md` extension? The test will fail for irrelevant reason.

That's where the mocks come to the rescue: instead of depending on `read_file`'s implementation, you set its behavior yourself:
```rust
#[mock]
fn read_file(path: Path) -> Result<String> {
    fs::read_to_string(path).unwrap()
}

// Arrange
let string = "first line\n\nthird_line";
// make `read_file` return `string` when it's called with "temp_file.txt" argument
read_file::setup("temp_file.txt").returns(string);

// Act
let result = read_file_lines("temp_file.txt");

// Assert
assert_eq!(result, vec!["first line", "third line"]);
```
