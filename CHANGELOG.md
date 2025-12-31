# Changelog

The format is based on [Keep a Changelog](https://keepachangelog.com/).

### Unreleased

### [1.3.4] - 2025-12-30

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
