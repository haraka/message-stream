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
        } catch (e) {
          // ignore
        }
      }
      try {
        fs.rmdirSync(TMP_DIR)
      } catch (e) {
        // ignore
      }
    }
  })

  it('spools to disk when buffer_max is exceeded', async () => {
    const cfg = {
      main: {
        spool_after: 10,
        spool_dir: TMP_DIR
      }
    }
    const id = 'test-spool'
    const ms = new MessageStream(cfg, id)
    
    ms.add_line('Header: 1\r\n')
    ms.add_line('\r\n')
    ms.add_line('Line 1\r\n')
    ms.add_line('Line 2\r\n') // Total size will exceed 10 bytes
    
    await new Promise((resolve) => ms.add_line_end(resolve))
    
    assert.strictEqual(ms.spooling, true, 'Should be spooling')
    assert.ok(fs.existsSync(path.join(TMP_DIR, `${id}.eml`)), 'Spool file should exist')
    
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
      'Epilogue\r\n'
    ]
    
    lines.forEach(line => ms.add_line(line))
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
      }
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

    assert.ok(result.includes('X-Test: true'), 'Should contain constructor headers')
    // Current behavior: if headers are passed to constructor, add_line headers are skipped until EOH
    assert.ok(!result.includes('Header: 1'), 'Should NOT contain added headers when constructor headers are present')
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
      }
    })

    const pipePromise = new Promise((resolve) => {
      dest1.on('finish', resolve)
    })

    ms.pipe(dest1)
    await pipePromise
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

  it('emits error if spool directory does not exist', async () => {
    const cfg = {
        main: {
            spool_after: 10,
            spool_dir: '/invalid/path/that/should/not/exist'
        }
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
})
