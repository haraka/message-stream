# Changelog

The format is based on [Keep a Changelog](https://keepachangelog.com/).

### Unreleased

### [1.3.0] - 2025-06-27

- fix: also remove dot-stuffing from leftovers #9
- change: rename dot_stuffing -> dot_stuffed, consistent with Haraka
  - improves readability, fixes a case of the not nots
- doc(README): add ref to Haraka Transaction docs showing usage
- deps(test-fixtures: bump to latest

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
