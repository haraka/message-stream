[![CI Test Status][ci-img]][ci-url]
[![Qlty][clim-img]][clim-url]
[![Test Coverage][cov-img]][cov-url]

# haraka-message-stream

A dual-mode message buffer for SMTP: accepts lines as they arrive from the wire, spools to disk when a size threshold is exceeded, and replays the message to one or more downstream consumers via a standard stream pipeline.

## Used By

- Haraka/transaction.js
- haraka/test-fixtures/transaction

## Construction

```js
const MessageStream = require('haraka-message-stream')

const ms = new MessageStream(cfg, uuid, headers)
```

| Parameter | Type       | Description                                                                                                                                     |
| --------- | ---------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| `cfg`     | `object`   | Haraka config object. Reads `cfg.main.spool_after` (bytes; `-1` = never spool; default 25 MiB) and `cfg.main.spool_dir` (path, default `/tmp`). |
| `uuid`    | `string`   | Required. Used as the spool filename base (`<spool_dir>/<uuid>.eml`).                                                                           |
| `headers` | `string[]` | Optional. Pre-parsed header lines. When supplied they are emitted first and the raw header block in stored data is skipped.                     |

## Writing

Feed lines in as they arrive. Call `add_line_end()` when the DATA terminator (`.`) is received.

```js
ms.add_line('From: sender@example.com\r\n')
ms.add_line('To: rcpt@example.com\r\n')
ms.add_line('\r\n') // end-of-headers blank line
ms.add_line('Hello, world.\r\n')

ms.add_line_end(() => {
  // writing is complete; safe to start reading
})
```

`add_line_end(cb)` is optional — the callback fires once all data has been flushed to memory or disk.

## Reading

#### `pipe(destination, options)` — legacy event-driven style

Replays the stored message to any writable stream. Can be called sequentially (not concurrently).

```js
const { createWriteStream } = require('fs')

ms.pipe(createWriteStream('/tmp/out.eml'))
```

**Pipe options**

| Option         | Type               | Default  | Description                                                                                                                                                                      |
| -------------- | ------------------ | -------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `line_endings` | `'\r\n'` \| `'\n'` | `'\r\n'` | Output line endings. Use `'\n'` to strip `\r` for local processing.                                                                                                              |
| `dot_stuffed`  | `boolean`          | `true`   | When `true`, removes SMTP dot-stuffing (`..line` → `.line`) for local delivery/scanning. Set to `false` when relaying over SMTP so stored dot-stuffing is preserved on the wire. |
| `ending_dot`   | `boolean`          | `false`  | Append `.\r\n` (or `.\n`) after the last body line — required when forwarding over SMTP. Forces stored dot-stuffing to be preserved on the wire (overrides `dot_stuffed`).       |
| `clamd_style`  | `boolean`          | `false`  | Prefix each chunk with a 4-byte big-endian length; append a 4-byte zero terminator. Used with ClamAV's INSTREAM protocol.                                                        |
| `skip_headers` | `boolean`          | `false`  | Omit the header block from output (emit body only).                                                                                                                              |
| `buffer_size`  | `number`           | `65536`  | Internal read chunk size in bytes.                                                                                                                                               |

```js
// Forward message over SMTP — preserve dot-stuffing, add terminating dot
ms.pipe(socket, { dot_stuffed: false, ending_dot: true })

// Local virus scan — unstuff dots, bare LF, clamd framing
ms.pipe(clamdSocket, {
  line_endings: '\n',
  dot_stuffed: true,
  clamd_style: true,
})

// Body-only, no \r, sequential second pass
ms.pipe(bodyParser, { skip_headers: true, line_endings: '\n' })
```

#### `unpipe()` — abort the active pipe

Tears down the internal source/transformer synchronously and frees the stream for a subsequent `pipe()`. Idempotent; no-op when no pipe is active.

**Call `unpipe()` before destroying the destination** when your handler reacts to a mid-stream failure (socket error, scan timeout, etc.) — the destination's `'close'` event is asynchronous, so calling `next()` immediately after `destination.destroy()` would race the cleanup and the next consumer's `pipe()` would throw `Cannot pipe while currently piping`.

```js
function onError(err) {
  ms.unpipe() // synchronous teardown
  socket.destroy()
  next()
}
socket.on('error', onError)
socket.on('timeout', onError)
ms.pipe(socket)
```

The library also installs prepended `'error'` / `'close'` listeners on the destination as a safety net, but consumers that synchronously start a new pipe must call `unpipe()` explicitly. See [haraka/message-stream#22](https://github.com/haraka/message-stream/issues/22).

### `get_data([options,] callback)` — collect into a Buffer

```js
ms.get_data((buf) => {
  console.log(buf.toString())
})

// with pipe options
ms.get_data({ line_endings: '\n', dot_stuffed: true }, (buf) => {
  process(buf)
})
```

### `for await...of` — modern async iterator

The stream implements `Symbol.asyncIterator`, so you can consume it with a `for await` loop. All pipe options are supported.

```js
// Default: CRLF, dot_stuffed: true
for await (const chunk of ms) {
  process(chunk)
}

// With options
for await (const chunk of ms[Symbol.asyncIterator]({ line_endings: '\n' })) {
  process(chunk)
}
```

## Spooling

When `total_buffered` exceeds `cfg.main.spool_after`, the stream transparently spools to `<spool_dir>/<uuid>.eml`. The consumer API is identical in both cases. The spool file is not removed automatically — call `ms.destroy()` when done.

`spool_after` accepted values:

- a finite non-negative number — spool once `total_buffered` exceeds this many bytes (`0` spools immediately);
- `-1` — never spool, keep everything in memory (matches Haraka's `connection.ini` sentinel);
- omitted / `undefined` — fall back to a safe 25 MiB default;
- anything else (non-numeric strings, `NaN`, other negatives) — rejected with a `console.warn`, default applies.

```js
const cfg = {
  main: {
    spool_after: 1024 * 1024, // spool messages larger than 1 MB
    spool_dir: '/var/spool/haraka',
  },
}

const ms = new MessageStream(cfg, transaction.uuid)
// ... write lines ...
ms.add_line_end(async () => {
  for await (const chunk of ms) {
    await forward(chunk)
  }
  ms.destroy() // close fd and remove spool file
})
```

## Flow control

```js
ms.pause() // suspend the active pipe's source readable
ms.resume() // resume it
ms.unpipe() // abort the active pipe (synchronous; see Reading)
ms.destroy() // close the spool file descriptor and delete the file
```

## Pipeline internals (2.x)

The 2.x refactor separated concerns into two composable Transform stages:

```
stored data
    │
    ▼
HeaderSkipper          (strips raw header block when constructor headers are used)
    │
    ▼
LineTransformer        (dot-unstuffing · CRLF normalisation · ending dot · clamd framing)
    │
    ▼
destination
```

`ChunkEmitter` is still exported for write-side batching used by `add_line`.

```js
const { ChunkEmitter } = require('haraka-message-stream')
```

## Error handling

Errors from disk I/O (spool open, write drain, read) are emitted on the `MessageStream` instance.

```js
ms.on('error', (err) => {
  console.error('message-stream error', err)
})
```

## REFERENCES

This module is used by Haraka [Transaction](https://haraka.github.io/core/Transaction).

<!-- leave these buried at the bottom of the document -->

[ci-img]: https://github.com/haraka/message-stream/actions/workflows/ci.yml/badge.svg
[ci-url]: https://github.com/haraka/message-stream/actions/workflows/ci.yml
[clim-img]: https://qlty.sh/gh/haraka/projects/message-stream/maintainability.svg
[clim-url]: https://qlty.sh/gh/haraka/projects/message-stream
[cov-img]: https://coveralls.io/repos/github/haraka/message-stream/badge.svg
[cov-url]: https://coveralls.io/github/haraka/message-stream
