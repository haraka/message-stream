# Changelog

The format is based on [Keep a Changelog](https://keepachangelog.com/).

### Unreleased

### [2.0.3] - 2026-04-23

- register `transformer.once('end'...)` before piping #21

### [2.0.2] - 2026-04-08

- fix: limit header size to prevent memory exhaustion
- fix: limit boundaries to prevent memory exhaustion
- fix: sanitize the spool filename, prevent path traversal
- fix: on Writable stream, set `autoClose: false`
  - `end` is a noop here, that's for fs.createReadableStream
- fix: wait until spool WS is flushed before pipe.
  - non-issue for node 22+, introduced in #19, race condition on node <= 20
- fix: GetDataStream must extend Writable, not legacy Stream #19

### [2.0.1] - 2026-04-02

- fix(pipe): honor `end: false` option to prevent closing destination when piping
- change: drop legacy dot_stuffing option
- test: add test coverage for `end: false` option

### [2.0.0] - 2026-03-23

#### Added

- docs(README): added pretty good documentation
- transformers: HeaderSkipper & LineTransformer (separated the concerns)
- async Iteration: implemented `Symbol.asyncIterator` for `for await...of`.
- pipeline Architecture: `pipe()` now generates independent `PassThrough` and `Transform` chains per call to support natural backpressure and sequential piping.

#### Changed

- style(exnext): converted `MessageStream` internal state (`#queue`, `#fd`, `#bufferMax`, etc.) to private class fields.
- style(esnext): replaced `write_complete` polling with a `_write_complete` event listener.
- source delegation: `pause()` and `resume()` now delegate directly to the active `#currentSource`.

#### Fixed

- error propagation: ensure disk I/O errors correctly propagate via `this.emit('error')`
- race conditions: updated `destroy()` to close file descriptors before unlinking to prevent `EBADF` errors.

### [1.3.3] - 2026-03-23

- test: added functional tests, coverage 69 -> 93%
- dep(h-test-fixtures): removed, unused
- ci publish: more permissions (#14)
- publish: add read perms (#13)

### [1.3.2] - 2025-12-30

- use optional chaining for c.main.dot_stuffed
- doc(README): remove code climate badge

### [1.3.1] - 2025-07-23

- fix: add a compat shim for dot_stuffing on Haraka < 3.1

### [1.3.0] - 2025-06-27

- fix: also remove dot-stuffing from leftovers #9
  - thanks to report at haraka/haraka-plugin-dkim#17
- test: add tests for removing dot-stuffing
- fix: replace polynomial regex with trimEnd()
- change: rename dot_stuffing -> dot_stuffed, consistent with Haraka
  - improves readability, fixes a case of the not nots
- change: switch test runner from mocha to `node --test`
- doc(README): add ref to Haraka Transaction docs showing usage
- deps(test-fixtures): bump to latest

### [1.2.3] - 2025-02-02

- dep(eslint): upgrade to v9
- prettier: move config into package.json

### [1.2.2] - 2024-08-05

- chore: populate [files] in package.json. Delete .npmignore.
- chore: automated code formatting
- ci: updated to shared configs
- dep: eslint-plugin-haraka -> @haraka/eslint-config
- doc: added CONTRIBUTORS.md
- doc: consistent naming of "special" files like CHANGELOG.md.

### [1.2.1] - 2024-04-03

- es6: use optional chaining (?.), for safety
- es6: use default function params

### [1.2.0] - 2022-06-24

- merged in ChunkEmitter, only used here
- copied in indexOfLF, removed haraka-utils dependency

### [1.1.0] - 2022-06-23

- fix: boundary marker corruption issue haraka/Haraka#3068

## 1.0.0 - 2022-06-23

- Import from Haraka
- convert tests to mocha

[1.1.0]: https://github.com/haraka/message-stream/releases/tag/v1.1.0
[1.2.0]: https://github.com/haraka/message-stream/releases/tag/v1.2.0
[1.2.1]: https://github.com/haraka/message-stream/releases/tag/v1.2.1
[1.2.2]: https://github.com/haraka/message-stream/releases/tag/v1.2.2
[1.2.3]: https://github.com/haraka/message-stream/releases/tag/v1.2.3
[1.0.0]: https://github.com/haraka/message-stream/releases/tag/v1.0.0
[1.3.0]: https://github.com/haraka/message-stream/releases/tag/v1.3.0
[1.3.1]: https://github.com/haraka/message-stream/releases/tag/v1.3.1
[1.3.2]: https://github.com/haraka/message-stream/releases/tag/v1.3.2
[1.3.3]: https://github.com/haraka/message-stream/releases/tag/v1.3.3
[2.0.0]: https://github.com/haraka/message-stream/releases/tag/v2.0.0
[2.0.1]: https://github.com/haraka/message-stream/releases/tag/v2.0.1
[2.0.2]: https://github.com/haraka/message-stream/releases/tag/v2.0.2
[2.0.3]: https://github.com/haraka/message-stream/releases/tag/v2.0.3
