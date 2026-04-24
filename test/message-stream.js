const assert = require('assert/strict')
const { describe, it } = require('node:test')
const stream = require('stream')

const MessageStream = require('../index')

describe('message-stream', () => {
  it('is a Stream', () => {
    const ms = new MessageStream({ main: {} }, 'msg', [])
    assert.ok(ms instanceof MessageStream)
    assert.ok(ms instanceof stream.Stream)
  })

  it('gets message data', async () => {
    const ms = new MessageStream({ main: {} }, 'msg', [])
    ms.add_line('Header: test\r\n')
    ms.add_line('\r\n')
    ms.add_line('I am body text\r\n')
    ms.add_line_end()

    const data = await new Promise((resolve) => {
      ms.get_data((data) => resolve(data))
    })
    assert.ok(/^[A-Za-z]+: /.test(data.toString()))
  })
})

function getOutputFromStream(inputLines, pipeOpts) {
  return new Promise((resolve) => {
    const ms = new MessageStream({ main: {} }, 'msg', [])
    const output = new stream.PassThrough()
    const chunks = []

    output.on('data', (chunk) => chunks.push(chunk.toString()))
    output.on('end', () => resolve(chunks.join('')))

    ms.pipe(output, pipeOpts)

    inputLines.forEach((line) => ms.add_line(line))
    ms.add_line_end()
  })
}

describe('dot_stuffed = false', function () {
  const pipeOpts = { dot_stuffed: false }

  it('does not stuff "..\\r\\n', async () => {
    const result = await getOutputFromStream(['..\r\n'], pipeOpts)
    assert.match(result, /^..\r\n/m)
  })

  it('does not stuff "..dot start\\r\\n"', async () => {
    const result = await getOutputFromStream(['..dot start\r\n'], pipeOpts)
    assert.match(result, /^..dot start\r\n/m)
  })

  it('leaves normal lines untouched', async () => {
    const result = await getOutputFromStream(
      ['hello\r\n', '..dot line\r\n', '..\r\n'],
      pipeOpts,
    )

    assert.equal(result, 'hello\r\n..dot line\r\n..\r\n')
  })
})

describe('dot_stuffed = true', function () {
  const pipeOpts = { dot_stuffed: true }

  it('unstuffs "..\\r\\n" to ".\\r\\n"', async () => {
    const result = await getOutputFromStream(['..\r\n'], pipeOpts)
    assert.match(result, /^.\r\n/m)
  })

  it('unstuffs "..dot start\\r\\n" to ".dot start\\r\\n"', async () => {
    const result = await getOutputFromStream(['..dot start\r\n'], pipeOpts)
    assert.match(result, /^.dot start\r\n/m)
  })

  it('leaves normal lines untouched', async () => {
    const result = await getOutputFromStream(
      ['hello\r\n', '..dot line\r\n', '..\r\n'],
      pipeOpts,
    )

    assert.equal(result, 'hello\r\n.dot line\r\n.\r\n')
    assert.match(result, /^hello\r\n/m)
    assert.match(result, /^.dot line\r\n/m)
    assert.match(result, /^.\r\n/m)
  })
})

describe('dot_stuffing = false (legacy)', function () {
  // sunset, delete after 2026
  const pipeOpts = { dot_stuffing: false }

  it('unstuffs "..\\r\\n" to ".\\r\\n"', async () => {
    const result = await getOutputFromStream(['..\r\n'], pipeOpts)
    assert.match(result, /^.\r\n/m)
  })

  it('unstuffs "..dot start\\r\\n" to ".dot start\\r\\n"', async () => {
    const result = await getOutputFromStream(['..dot start\r\n'], pipeOpts)
    assert.match(result, /^.dot start\r\n/m)
  })

  it('leaves normal lines untouched', async () => {
    const result = await getOutputFromStream(
      ['hello\r\n', '..dot line\r\n', '..\r\n'],
      pipeOpts,
    )

    assert.equal(result, 'hello\r\n.dot line\r\n.\r\n')
  })
})

describe('pipe end option', () => {
  it('calls destination.end() by default', async () => {
    const ms = new MessageStream({ main: {} }, 'msg', [])
    const dest = new stream.PassThrough()
    let endCalled = false
    dest.on('finish', () => {
      endCalled = true
    })

    ms.pipe(dest)
    ms.add_line('hello\r\n')
    ms.add_line_end()

    await new Promise((resolve) => dest.on('finish', resolve))
    assert.equal(endCalled, true)
  })

  it('does not call destination.end() when end: false', async () => {
    const ms = new MessageStream({ main: {} }, 'msg', [])
    const dest = new stream.PassThrough()
    let endCalled = false
    dest.on('finish', () => {
      endCalled = true
    })

    const chunks = []
    dest.on('data', (chunk) => chunks.push(chunk.toString()))

    ms.pipe(dest, { end: false })
    ms.add_line('hello\r\n')
    ms.add_line_end()

    // Wait for data to flow through — use transformer's 'end' signal via a short wait
    await new Promise((resolve) => setTimeout(resolve, 20))
    assert.equal(
      endCalled,
      false,
      'destination.end() should not be called when end: false',
    )
    assert.ok(chunks.join('').includes('hello'), 'data should still be piped')
  })

  it('ending_dot with end: false writes dot but does not close destination (smtp_client use case)', async () => {
    const ms = new MessageStream({ main: {} }, 'msg', [])
    const dest = new stream.PassThrough()
    let endCalled = false
    dest.on('finish', () => {
      endCalled = true
    })

    const chunks = []
    dest.on('data', (chunk) => chunks.push(chunk.toString()))

    ms.pipe(dest, { dot_stuffed: false, ending_dot: true, end: false })
    ms.add_line('Subject: test\r\n')
    ms.add_line('\r\n')
    ms.add_line('body\r\n')
    ms.add_line_end()

    await new Promise((resolve) => setTimeout(resolve, 20))
    const output = chunks.join('')
    assert.ok(output.endsWith('.\r\n'), 'ending dot must be written')
    assert.equal(
      endCalled,
      false,
      'destination must remain open for server response',
    )
  })
})

describe('sequential pipe', () => {
  it('allows a second pipe started synchronously from the first pipe end callback', (t, done) => {
    // Regression test for haraka/Haraka#3551:
    // When destination.end() is called synchronously inside the 'end' listener
    // registered by pipe(), and that callback triggers another pipe(), the
    // #inPipe guard must already be cleared or it throws "Cannot pipe while
    // currently piping".
    const ms = new MessageStream({ main: {} }, 'msg', [])
    ms.add_line('Subject: test\r\n')
    ms.add_line('\r\n')
    ms.add_line('body\r\n')
    ms.add_line_end()

    const chunks1 = []
    const chunks2 = []

    // First destination: a writable that triggers a second pipe synchronously
    // inside its end() — simulating what DKIMSignStream does.
    const dest1 = new stream.Writable({
      write(chunk, _enc, cb) {
        chunks1.push(chunk.toString())
        cb()
      },
      final(cb) {
        cb()
        // Synchronously start a second pipe, just like DKIMSignStream's callback
        // calls next() which leads to process_delivery which pipes the stream again.
        const dest2 = new stream.PassThrough()
        dest2.on('data', (c) => chunks2.push(c.toString()))
        dest2.on('end', () => {
          assert.ok(chunks2.join('').length > 0, 'second pipe received data')
          done()
        })
        ms.pipe(dest2)
      },
    })

    ms.pipe(dest1)
  })
})
