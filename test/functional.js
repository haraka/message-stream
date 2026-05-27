const assert = require('node:assert/strict')
const { describe, it, beforeEach, afterEach } = require('node:test')
const fs = require('node:fs')
const path = require('node:path')
const stream = require('node:stream')
const MessageStream = require('../index')

const TMP_DIR = path.join(__dirname, 'tmp')

describe('MessageStream Functional Tests', () => {
  beforeEach(() => {
    if (!fs.existsSync(TMP_DIR)) {
      fs.mkdirSync(TMP_DIR)
    }
  })

  afterEach(() => {
    if (fs.existsSync(TMP_DIR)) {
      const files = fs.readdirSync(TMP_DIR)
      for (const file of files) {
        try {
          fs.unlinkSync(path.join(TMP_DIR, file))
        } catch {}
      }
      try {
        fs.rmdirSync(TMP_DIR)
      } catch {}
    }
  })

  it('uses safe default spool_after when none is configured', async () => {
    // No spool_after: previously kept all data in memory (DoS vector).
    // Now should spool once total_buffered crosses the safe default (~25 MiB).
    const cfg = { main: { spool_dir: TMP_DIR } }
    const id = 'test-default-spool'
    const ms = new MessageStream(cfg, id)

    ms.add_line('Header: x\r\n')
    ms.add_line('\r\n')
    const mb = `${'a'.repeat(1024 * 1024 - 2)}\r\n` // ~1 MiB per line
    for (let i = 0; i < 26; i++) ms.add_line(mb)
    await new Promise((resolve) => ms.add_line_end(resolve))

    assert.strictEqual(ms.spooling, true, 'should spool with the safe default')
    ms.destroy()
  })

  it('honors spool_after=-1 as "never spool" (Haraka connection.ini sentinel)', async () => {
    const cfg = { main: { spool_after: -1, spool_dir: TMP_DIR } }
    const ms = new MessageStream(cfg, 'test-never-spool')
    ms.add_line('Header: x\r\n')
    ms.add_line('\r\n')
    const mb = `${'a'.repeat(1024 * 1024 - 2)}\r\n`
    for (let i = 0; i < 30; i++) ms.add_line(mb)
    await new Promise((resolve) => ms.add_line_end(resolve))
    assert.strictEqual(ms.spooling, false, '-1 should disable spooling')
    ms.destroy()
  })

  it('rejects non-numeric spool_after and falls back to the safe default', async () => {
    const warns = []
    const origWarn = console.warn
    console.warn = (msg) => warns.push(String(msg))
    try {
      const cfg = { main: { spool_after: 'lots', spool_dir: TMP_DIR } }
      const ms = new MessageStream(cfg, 'test-bad-spool')
      ms.add_line('Header: x\r\n')
      ms.add_line('\r\n')
      ms.add_line('tiny body\r\n')
      await new Promise((resolve) => ms.add_line_end(resolve))
      assert.strictEqual(ms.spooling, false, 'small message stays in memory')
      ms.destroy()
    } finally {
      console.warn = origWarn
    }
    assert.ok(
      warns.some((w) => /spool_after/.test(w)),
      'should warn about invalid spool_after',
    )
  })

  it('destroy() during pending spool open closes the fd and removes the file', async () => {
    // Delay the WriteStream 'open' event so destroy() reliably runs while
    // open is pending. Without the C1 fix the late-arriving fd is captured
    // by the open callback but never closed.
    const origCreate = fs.createWriteStream
    const origClose = fs.close
    let receivedFd = null
    const closedFds = []
    fs.close = (fd, cb) => {
      closedFds.push(fd)
      return origClose(fd, cb)
    }
    fs.createWriteStream = (...args) => {
      const ws = origCreate(...args)
      const realEmit = ws.emit.bind(ws)
      ws.emit = function (ev, fd, ...rest) {
        if (ev === 'open') {
          receivedFd = fd
          setTimeout(() => realEmit(ev, fd, ...rest), 30)
          return true
        }
        return realEmit(ev, fd, ...rest)
      }
      return ws
    }

    const cfg = { main: { spool_after: 10, spool_dir: TMP_DIR } }
    const id = 'destroy-pending-open'
    const spoolPath = path.join(TMP_DIR, `${id}.eml`)
    try {
      const ms = new MessageStream(cfg, id)
      ms.add_line('Header: x\r\n')
      ms.add_line('\r\n')
      ms.add_line('xxxxxxxxxxxx\r\n')
      ms.add_line_end()
      ms.destroy() // open still pending
      await new Promise((r) => setTimeout(r, 80))
      assert.ok(receivedFd !== null, 'open event should have fired')
      assert.ok(
        closedFds.includes(receivedFd),
        'fd from late open should be closed',
      )
      assert.equal(
        fs.existsSync(spoolPath),
        false,
        'spool file should not be left behind',
      )
    } finally {
      fs.createWriteStream = origCreate
      fs.close = origClose
    }
  })

  it('spools to disk when buffer_max is exceeded', async () => {
    const cfg = {
      main: {
        spool_after: 10,
        spool_dir: TMP_DIR,
      },
    }
    const id = 'test-spool'
    const ms = new MessageStream(cfg, id)

    ms.add_line('Header: 1\r\n')
    ms.add_line('\r\n')
    ms.add_line('Line 1\r\n')
    ms.add_line('Line 2\r\n') // Total size will exceed 10 bytes

    await new Promise((resolve) => ms.add_line_end(resolve))

    assert.strictEqual(ms.spooling, true, 'Should be spooling')
    assert.ok(
      fs.existsSync(path.join(TMP_DIR, `${id}.eml`)),
      'Spool file should exist',
    )

    const chunks = []
    const dest = new stream.PassThrough()

    const pipePromise = new Promise((resolve, reject) => {
      dest.on('data', (chunk) => chunks.push(chunk))
      dest.on('end', () => resolve(Buffer.concat(chunks).toString()))
      dest.on('error', reject)
    })

    ms.pipe(dest)
    const result = await pipePromise

    assert.ok(result.includes('Header: 1'), 'Should contain headers')
    assert.ok(result.includes('Line 1'), 'Should contain line 1')
    assert.ok(result.includes('Line 2'), 'Should contain line 2')
    ms.destroy()
  })

  it('spool file is fully written before add_line_end callback fires', async () => {
    // Regression: on Node v20, #endCallback fired when the in-memory queue was
    // drained but before the fs.WriteStream had flushed to disk.  Reading the
    // spool file synchronously right after the callback exposes the race.
    const cfg = {
      main: {
        spool_after: 10, // tiny threshold so every line triggers spooling
        spool_dir: TMP_DIR,
      },
    }
    const id = 'test-spool-flush'
    const ms = new MessageStream(cfg, id)
    const spoolFile = path.join(TMP_DIR, `${id}.eml`)

    ms.add_line('Header: 1\r\n')
    ms.add_line('\r\n')
    ms.add_line('Line 1\r\n')
    ms.add_line('Line 2\r\n')

    // The callback must fire only after all data is durably on disk
    await new Promise((resolve) => ms.add_line_end(resolve))

    assert.strictEqual(ms.spooling, true, 'Should be spooling')

    // Synchronous read: if the callback fired before the WriteStream flushed,
    // this will see an empty or truncated file and the assertions will fail.
    const spoolContent = fs.readFileSync(spoolFile, 'utf8')
    assert.ok(
      spoolContent.includes('Header: 1'),
      'Spool file must contain headers when callback fires',
    )
    assert.ok(
      spoolContent.includes('Line 1'),
      'Spool file must contain Line 1 when callback fires',
    )
    assert.ok(
      spoolContent.includes('Line 2'),
      'Spool file must contain Line 2 when callback fires',
    )

    ms.destroy()
  })

  it('correctly indexes headers and MIME boundaries', async () => {
    const ms = new MessageStream({ main: {} }, 'test-idx')

    const lines = [
      'Header: 1\r\n',
      'Header: 2\r\n',
      '\r\n',
      'Body start\r\n',
      '--boundary\r\n',
      'Part 1\r\n',
      '--boundary\r\n',
      'Part 2\r\n',
      '--boundary--\r\n',
      'Epilogue\r\n',
    ]

    lines.forEach((line) => ms.add_line(line))
    await new Promise((resolve) => ms.add_line_end(resolve))

    assert.ok(ms.idx.headers, 'Headers should be indexed')
    assert.ok(ms.idx.body, 'Body should be indexed')
    assert.ok(ms.idx.boundary, 'Boundary should be indexed')

    // Check indices
    assert.strictEqual(ms.idx.headers.start, 0)
    // Header: 1\r\n (11) + Header: 2\r\n (11) = 22
    assert.strictEqual(ms.idx.headers.end, 22)

    // Body starts after \r\n (22 + 2 = 24)
    assert.strictEqual(ms.idx.body.start, 24)

    // Boundary start/end
    assert.ok(ms.idx.boundary.start > 0)
    assert.ok(ms.idx.boundary.end > ms.idx.boundary.start)

    ms.destroy()
  })

  it('handles clamd_style piping', async () => {
    const ms = new MessageStream({ main: {} }, 'test-clamd')
    ms.add_line('Test data\r\n')
    await new Promise((resolve) => ms.add_line_end(resolve))

    const chunks = []
    const dest = new stream.PassThrough()

    const pipePromise = new Promise((resolve) => {
      dest.on('data', (chunk) => chunks.push(chunk))
      dest.on('end', () => resolve(Buffer.concat(chunks)))
    })

    ms.pipe(dest, { clamd_style: true })
    const result = await pipePromise

    // clamd style: 4 bytes length (BE) + data
    assert.strictEqual(result.readUInt32BE(0), 11) // 'Test data\r\n' is 11 bytes
    assert.strictEqual(result.slice(4, 15).toString(), 'Test data\r\n')
    // plus final 4 bytes of 0
    assert.strictEqual(result.readUInt32BE(result.length - 4), 0)
    ms.destroy()
  })

  it('handles ending_dot option', async () => {
    const ms = new MessageStream({ main: {} }, 'test-dot')
    ms.add_line('Test data\r\n')
    await new Promise((resolve) => ms.add_line_end(resolve))

    const chunks = []
    const dest = new stream.PassThrough()

    const pipePromise = new Promise((resolve) => {
      dest.on('data', (chunk) => chunks.push(chunk))
      dest.on('end', () => resolve(Buffer.concat(chunks).toString()))
    })

    ms.pipe(dest, { ending_dot: true })
    const result = await pipePromise

    assert.ok(result.endsWith('Test data\r\n.\r\n'))
    ms.destroy()
  })

  it('respects line_endings: "\\n"', async () => {
    const ms = new MessageStream({ main: {} }, 'test-lf')
    ms.add_line('Header: 1\r\n')
    ms.add_line('\r\n')
    ms.add_line('Line 1\r\n')
    await new Promise((resolve) => ms.add_line_end(resolve))

    const chunks = []
    const dest = new stream.PassThrough()

    const pipePromise = new Promise((resolve) => {
      dest.on('data', (chunk) => chunks.push(chunk))
      dest.on('end', () => resolve(Buffer.concat(chunks).toString()))
    })

    ms.pipe(dest, { line_endings: '\n' })
    const result = await pipePromise

    assert.ok(!result.includes('\r'), 'Should not contain CR')
    assert.ok(result.includes('Header: 1\n'), 'Should contain LF headers')
    assert.ok(result.includes('Line 1\n'), 'Should contain LF body')
    ms.destroy()
  })

  it('handles pause and resume', async () => {
    const ms = new MessageStream({ main: {} }, 'test-pause')

    for (let i = 0; i < 100; i++) {
      ms.add_line(`Line ${i}\r\n`)
    }

    await new Promise((resolve) => ms.add_line_end(resolve))

    const chunks = []
    const dest = new stream.Writable({
      write(chunk, encoding, callback) {
        chunks.push(chunk)
        // Pause for a bit
        ms.pause()
        setTimeout(() => {
          ms.resume()
          callback()
        }, 10)
      },
    })

    const pipePromise = new Promise((resolve) => {
      dest.on('finish', () => resolve(Buffer.concat(chunks).toString()))
    })

    ms.pipe(dest, { buffer_size: 100 })
    const result = await pipePromise

    assert.ok(result.includes('Line 0'))
    assert.ok(result.includes('Line 99'))
    ms.destroy()
  })

  it('respects skip_headers option', async () => {
    const ms = new MessageStream({ main: {} }, 'test-skip-headers')
    ms.add_line('Header: 1\r\n')
    ms.add_line('\r\n')
    ms.add_line('Body Line\r\n')
    await new Promise((resolve) => ms.add_line_end(resolve))

    const chunks = []
    const dest = new stream.PassThrough()
    const pipePromise = new Promise((resolve) => {
      dest.on('data', (chunk) => chunks.push(chunk))
      dest.on('end', () => resolve(Buffer.concat(chunks).toString()))
    })

    ms.pipe(dest, { skip_headers: true })
    const result = await pipePromise

    assert.ok(!result.includes('Header: 1'), 'Should not contain headers')
    assert.ok(result.includes('Body Line'), 'Should contain body')
    ms.destroy()
  })

  it('includes headers passed to constructor', async () => {
    const headers = ['X-Test: true\r\n']
    const ms = new MessageStream({ main: {} }, 'test-ctor-headers', headers)
    ms.add_line('Header: 1\r\n')
    ms.add_line('\r\n')
    ms.add_line('Body Line\r\n')
    await new Promise((resolve) => ms.add_line_end(resolve))

    const chunks = []
    const dest = new stream.PassThrough()
    const pipePromise = new Promise((resolve) => {
      dest.on('data', (chunk) => chunks.push(chunk))
      dest.on('end', () => resolve(Buffer.concat(chunks).toString()))
    })

    ms.pipe(dest)
    const result = await pipePromise

    assert.ok(
      result.includes('X-Test: true'),
      'Should contain constructor headers',
    )
    // Current behavior: if headers are passed to constructor, add_line headers are skipped until EOH
    assert.ok(
      !result.includes('Header: 1'),
      'Should NOT contain added headers when constructor headers are present',
    )
    assert.ok(result.includes('Body Line'), 'Should contain body line')
    ms.destroy()
  })

  it('throws when piping while already piping', async () => {
    const ms = new MessageStream({ main: {} }, 'test-multi-pipe')
    ms.add_line('Line 1\r\n')
    ms.add_line('Line 2\r\n')
    await new Promise((resolve) => ms.add_line_end(resolve))

    const dest1 = new stream.Writable({
      write(chunk, encoding, callback) {
        // When we receive the first chunk, try to pipe again
        assert.throws(() => {
          ms.pipe(new stream.PassThrough())
        }, /Cannot pipe while currently piping/)
        callback()
      },
    })

    const pipePromise = new Promise((resolve) => {
      dest1.on('finish', resolve)
    })

    ms.pipe(dest1)
    await pipePromise
    ms.destroy()
  })

  it('recovers when destination errors mid-pipe', async () => {
    // Regression for haraka/message-stream#22.
    const cfg = { main: { spool_after: 10, spool_dir: TMP_DIR } }
    const ms = new MessageStream(cfg, 'test-dest-error-recover')
    ms.add_line('Header: 1\r\n')
    ms.add_line('\r\n')
    // Enough data to ensure spool path + multiple write callbacks
    for (let i = 0; i < 200; i++) {
      ms.add_line(`Body line ${i} ${'x'.repeat(80)}\r\n`)
    }
    await new Promise((resolve) => ms.add_line_end(resolve))

    // Destination that errors on the first write, mimicking EPIPE.
    const flaky = new stream.Writable({
      write(_chunk, _enc, cb) {
        const err = new Error('write EPIPE')
        err.code = 'EPIPE'
        cb(err)
      },
    })

    const flakyDone = new Promise((resolve) => {
      flaky.once('error', () => {
        // Mirror what a Haraka plugin does on socket error:
        flaky.destroy()
        resolve()
      })
    })

    ms.pipe(flaky)
    await flakyDone
    // Give the upstream pipeline a tick to observe the destination teardown
    await new Promise((resolve) => setImmediate(resolve))

    // Subsequent pipe() must NOT throw "Cannot pipe while currently piping".
    const chunks = []
    const dest = new stream.PassThrough()
    const pipePromise = new Promise((resolve, reject) => {
      dest.on('data', (chunk) => chunks.push(chunk))
      dest.on('end', () => resolve(Buffer.concat(chunks).toString()))
      dest.on('error', reject)
    })

    assert.doesNotThrow(() => ms.pipe(dest))
    const result = await pipePromise

    assert.ok(
      result.includes('Header: 1'),
      'second pipe should deliver headers',
    )
    assert.ok(
      result.includes('Body line 0'),
      'second pipe should deliver body lines',
    )
    assert.ok(
      result.includes('Body line 199'),
      'second pipe should deliver all body lines',
    )
    ms.destroy()
  })

  it('allows a synchronous re-pipe from a destination error handler', async () => {
    // Stricter regression for haraka/message-stream#22: locks in the
    // prependOnceListener semantics so cleanup runs before consumer handlers.
    const ms = new MessageStream({ main: {} }, 'test-sync-repipe')
    ms.add_line('Header: 1\r\n')
    ms.add_line('\r\n')
    ms.add_line('Body\r\n')
    await new Promise((resolve) => ms.add_line_end(resolve))

    const flaky = new stream.Writable({
      write(_chunk, _enc, cb) {
        cb(new Error('write EPIPE'))
      },
    })

    let secondPipeError = null
    let secondPipeOk = false

    flaky.on('error', () => {
      // Plugin pattern: destroy destination, then synchronously kick off the
      // "next plugin" which tries to pipe again on the same MessageStream.
      flaky.destroy()
      try {
        const dest = new stream.PassThrough()
        dest.resume() // discard data
        ms.pipe(dest)
        secondPipeOk = true
      } catch (e) {
        secondPipeError = e
      }
    })

    ms.pipe(flaky)
    // Drain the event loop so the error+re-pipe sequence completes.
    await new Promise((resolve) => setImmediate(resolve))
    await new Promise((resolve) => setImmediate(resolve))

    assert.strictEqual(secondPipeError, null, 'sync re-pipe must not throw')
    assert.strictEqual(secondPipeOk, true, 'sync re-pipe must succeed')
    ms.destroy()
  })

  it('cleanup removes all registered listeners (no leaks)', async () => {
    // Regression for the Copilot findings on haraka/message-stream#23: cleanup
    // must remove the queued _write_complete listener AND the destination
    // error/close listeners so they don't accumulate or fire after teardown.
    const ms = new MessageStream({ main: {} }, 'test-no-leaks')
    ms.add_line('Hi\r\n')

    // Pipe BEFORE add_line_end — exercises the _write_complete-queued path.
    const dest1 = new stream.PassThrough()
    dest1.resume()
    const wcBefore = ms.listenerCount('_write_complete')
    ms.pipe(dest1)
    assert.equal(
      ms.listenerCount('_write_complete'),
      wcBefore + 1,
      'pipe queues a _write_complete listener',
    )
    ms.unpipe()
    assert.equal(
      ms.listenerCount('_write_complete'),
      wcBefore,
      'unpipe removes the queued _write_complete listener',
    )

    // Happy path: pipe to completion, ensure destination listeners are detached.
    await new Promise((resolve) => ms.add_line_end(resolve))
    const dest2 = new stream.PassThrough()
    dest2.resume()
    const before = {
      err: dest2.listenerCount('error'),
      close: dest2.listenerCount('close'),
    }
    await new Promise((resolve) => {
      dest2.on('end', resolve)
      ms.pipe(dest2)
    })
    assert.equal(
      dest2.listenerCount('error'),
      before.err,
      'destination error listener removed after pipe completes',
    )
    assert.equal(
      dest2.listenerCount('close'),
      before.close,
      'destination close listener removed after pipe completes',
    )
    ms.destroy()
  })

  it('unpipe() synchronously frees the stream for a new pipe', async () => {
    // Covers the async-destroy case in haraka/message-stream#22.
    const ms = new MessageStream({ main: {} }, 'test-unpipe-sync')
    ms.add_line('A\r\n')
    await new Promise((resolve) => ms.add_line_end(resolve))

    // Slow consumer: never lets the pipe finish on its own.
    const slow = new stream.Writable({
      write(_c, _e, cb) {
        /* never callback — simulates a stalled remote */
      },
    })
    ms.pipe(slow)

    // Synchronously abort and start a new pipe before any async event fires.
    ms.unpipe()

    const chunks = []
    const dest = new stream.PassThrough()
    const done = new Promise((resolve) => {
      dest.on('data', (c) => chunks.push(c))
      dest.on('end', () => resolve(Buffer.concat(chunks).toString()))
    })

    assert.doesNotThrow(() => ms.pipe(dest))
    const result = await done
    assert.ok(result.includes('A'), 'second pipe must deliver content')

    slow.destroy()
    ms.destroy()
  })

  it('handles sequential piping', async () => {
    const ms = new MessageStream({ main: {} }, 'test-seq-pipe')
    ms.add_line('Test Data\r\n')
    await new Promise((resolve) => ms.add_line_end(resolve))

    const getResult = (pipeOpts) => {
      const chunks = []
      const dest = new stream.PassThrough()
      const p = new Promise((resolve) => {
        dest.on('data', (chunk) => chunks.push(chunk))
        dest.on('end', () => resolve(Buffer.concat(chunks).toString()))
      })
      ms.pipe(dest, pipeOpts)
      return p
    }

    const res1 = await getResult()
    assert.strictEqual(res1, 'Test Data\r\n')

    const res2 = await getResult({ line_endings: '\n' })
    assert.strictEqual(res2, 'Test Data\n')

    ms.destroy()
  })

  it('get_data() returns full body for spooled messages with ctor headers', async () => {
    const cfg = {
      main: {
        spool_after: 5 * 1024 * 1024, // 5 MB, matches realistic production
        spool_dir: TMP_DIR,
      },
    }
    // Pass header_list like Haraka's transaction.js does
    const headers = ['From: a@example.com\r\n', 'To: b@example.com\r\n']
    const ms = new MessageStream(cfg, 'test-get-data-spool-hdrs', headers)

    // Feed headers + large body
    ms.add_line('From: a@example.com\r\n')
    ms.add_line('To: b@example.com\r\n')
    ms.add_line('\r\n')
    // 6 MB of 76-character base64-like lines (realistic attachment shape)
    const line = 'A'.repeat(76) + '\r\n'
    const linesNeeded = Math.ceil((6 * 1024 * 1024) / line.length)
    for (let i = 0; i < linesNeeded; i++) {
      ms.add_line(line)
    }

    await new Promise((resolve) => ms.add_line_end(resolve))
    assert.strictEqual(ms.spooling, true, 'message should have been spooled')

    const buffer = await new Promise((resolve, reject) => {
      const timeout = setTimeout(
        () => reject(new Error('get_data callback never fired')),
        3000,
      )
      ms.get_data((data) => {
        clearTimeout(timeout)
        resolve(data)
      })
    })

    assert.ok(buffer.length > 5 * 1024 * 1024, 'should return full body')
    const str = buffer.toString('utf8', 0, 200)
    assert.ok(str.includes('From: a@example.com'), 'should contain headers')
    ms.destroy()
  })

  it('emits error if spool directory does not exist', async () => {
    const cfg = {
      main: {
        spool_after: 10,
        spool_dir: '/invalid/path/that/should/not/exist',
      },
    }
    const ms = new MessageStream(cfg, 'test-error')

    const errorPromise = new Promise((resolve) => {
      ms.on('error', (err) => resolve(err))
    })

    ms.add_line('Header: 1\r\n')
    ms.add_line('\r\n')
    ms.add_line('Large line to trigger spooling' + 'A'.repeat(100) + '\r\n')
    ms.add_line_end()

    const error = await errorPromise
    assert.ok(error instanceof Error)
    assert.strictEqual(error.code, 'ENOENT')
    ms.destroy()
  })

  it('limits the number of keys in idx', async () => {
    const ms = new MessageStream({ main: {} }, 'test-idx-limit')

    // Headers + Body
    ms.add_line('Header: 1\r\n')
    ms.add_line('\r\n')

    // Add 2000 unique boundaries
    for (let i = 0; i < 2000; i++) {
      ms.add_line(`--boundary-${i}\r\n`)
    }

    await new Promise((resolve) => ms.add_line_end(resolve))

    const idxCount = Object.keys(ms.idx).length
    assert.ok(
      idxCount <= 1002,
      `Idx count should be limited (actual: ${idxCount})`,
    )
    // 1002 because headers and body are also indexed
    ms.destroy()
  })

  it('prevents path traversal in id', async () => {
    const id = '../../../../../../../../tmp/pwned'
    const ms = new MessageStream(
      { main: { spool_after: 0, spool_dir: TMP_DIR } },
      id,
    )

    ms.add_line('test\r\n')
    ms.add_line_end()

    // Trigger spooling
    await new Promise((resolve) => setTimeout(resolve, 100))

    assert.ok(
      !fs.existsSync('/tmp/pwned.eml'),
      'Should NOT have created file outside spool dir',
    )
    assert.ok(
      fs.existsSync(path.join(TMP_DIR, 'pwned.eml')),
      'Should have created file inside spool dir',
    )

    ms.destroy()
  })

  it('HeaderSkipper emits error if headers are too large', async () => {
    const ms = new MessageStream({ main: {} }, 'test-skipper-limit')

    // Send 2MB of data with no LF
    const largeData = 'A'.repeat(2 * 1024 * 1024)
    ms.add_line(largeData)
    await new Promise((resolve) => ms.add_line_end(resolve))

    const dest = new stream.PassThrough()
    const errorPromise = new Promise((resolve) => {
      ms.on('error', (err) => resolve(err))
    })

    // skip_headers: true triggers HeaderSkipper
    ms.pipe(dest, { skip_headers: true })

    const error = await errorPromise
    assert.ok(error instanceof Error)
    assert.strictEqual(error.message, 'Header size limit exceeded')
    ms.destroy()
  })
})
