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

  it('boundary index does not pollute Object.prototype', () => {
    const probe = {}
    assert.equal(probe.end, undefined, 'precondition: clean prototype')

    const ms = new MessageStream({ main: {} }, 'msg-proto', [])
    ms.add_line('Header: x\r\n')
    ms.add_line('\r\n')
    ms.add_line('--__proto__--\r\n')
    ms.add_line_end()

    assert.equal({}.end, undefined, 'Object.prototype.end was mutated')
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

// GHSA-rp4q-8m6x-c43c: header_list holds dot-unstuffed logical values; on relay
// they must be re-stuffed or a line reading as '.' becomes an end-of-DATA
// terminator on the backend (SMTP transaction smuggling).
function getOutputFromCtorHeaders(headerList, bodyLines, pipeOpts) {
  return new Promise((resolve) => {
    const ms = new MessageStream({ main: {} }, 'msg', headerList)
    const output = new stream.PassThrough()
    const chunks = []
    output.on('data', (chunk) => chunks.push(chunk.toString()))
    output.on('end', () => resolve(chunks.join('')))
    ms.pipe(output, pipeOpts)
    for (const h of headerList) ms.add_line(h.endsWith('\n') ? h : `${h}\n`)
    ms.add_line('\r\n')
    for (const line of bodyLines) ms.add_line(line)
    ms.add_line_end()
  })
}

const RELAY = { dot_stuffed: false, ending_dot: true }
const PRESERVE = { dot_stuffed: false, ending_dot: false }
const LOCAL = { dot_stuffed: true, ending_dot: false }
const DOT_HEADERS = ['From: a@b.com\n', 'Subject: x\n', '.\n', 'To: c@d.com\n']
const DDOT_HEADERS = ['From: a@b.com\n', '..weird: v\n', 'To: c@d.com\n']
const countTerminators = (out) =>
  out.split('\r\n').filter((l) => l === '.').length

describe('constructor-header dot-stuffing', function () {
  it('re-stuffs a lone-dot header on relay so it cannot terminate DATA', async () => {
    const out = await getOutputFromCtorHeaders(DOT_HEADERS, ['body\r\n'], RELAY)
    assert.equal(countTerminators(out), 1)
    assert.match(out, /Subject: x\r\n\.\.\r\nTo: c@d\.com/)
  })

  it('re-stuffs a header beginning with a dot on relay', async () => {
    const out = await getOutputFromCtorHeaders(
      ['From: a@b.com\n', '.foo: bar\n'],
      ['body\r\n'],
      RELAY,
    )
    assert.match(out, /^\.\.foo: bar\r\n/m)
  })

  it('stuffs a double-dot header on relay so the backend restores it', async () => {
    const out = await getOutputFromCtorHeaders(
      DDOT_HEADERS,
      ['body\r\n'],
      RELAY,
    )
    assert.match(out, /^\.\.\.weird: v\r\n/m)
  })

  it('cannot leak a terminator when ending_dot is combined with dot_stuffed:true', async () => {
    const out = await getOutputFromCtorHeaders(DOT_HEADERS, ['body\r\n'], {
      dot_stuffed: true,
      ending_dot: true,
    })
    assert.equal(countTerminators(out), 1)
    assert.match(out, /Subject: x\r\n\.\.\r\nTo: c@d\.com/)
  })

  it('leaves ordinary headers untouched on relay', async () => {
    const out = await getOutputFromCtorHeaders(
      ['From: a@b.com\n', 'Subject: hello\n'],
      ['body\r\n'],
      RELAY,
    )
    assert.match(out, /^From: a@b\.com\r\n/m)
    assert.match(out, /^Subject: hello\r\n/m)
  })

  it('preserves the logical form for a non-relay preserve sink', async () => {
    const out = await getOutputFromCtorHeaders(
      DOT_HEADERS,
      ['body\r\n'],
      PRESERVE,
    )
    assert.match(out, /^\.\r\n/m)
    assert.doesNotMatch(out, /^\.\.\r\n/m)
  })

  it('emits the logical lone-dot header for local delivery', async () => {
    const out = await getOutputFromCtorHeaders(DOT_HEADERS, ['body\r\n'], LOCAL)
    assert.match(out, /^\.\r\n/m)
    assert.doesNotMatch(out, /^\.\.\r\n/m)
  })

  it('does not corrupt a double-dot header for local delivery', async () => {
    const out = await getOutputFromCtorHeaders(
      DDOT_HEADERS,
      ['body\r\n'],
      LOCAL,
    )
    assert.match(out, /^\.\.weird: v\r\n/m)
    assert.doesNotMatch(out, /^\.weird: v\r\n/m)
  })
})

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

describe('dot_stuffing = true (legacy, Haraka < 3.1)', function () {
  // Haraka < 3.1 passed { dot_stuffing: true } when writing the queue file.
  // dot_stuffing: true is the inverse of dot_stuffed: false — dots must be preserved.
  const pipeOpts = { dot_stuffing: true }

  it('does not unstuff "..\\r\\n"', async () => {
    const result = await getOutputFromStream(['..\r\n'], pipeOpts)
    assert.equal(result, '..\r\n')
  })

  it('does not unstuff "..dot start\\r\\n"', async () => {
    const result = await getOutputFromStream(['..dot start\r\n'], pipeOpts)
    assert.equal(result, '..dot start\r\n')
  })

  it('leaves normal lines untouched', async () => {
    const result = await getOutputFromStream(
      ['hello\r\n', '..dot line\r\n', '..\r\n'],
      pipeOpts,
    )
    assert.equal(result, 'hello\r\n..dot line\r\n..\r\n')
  })
})

describe('dot_stuffing = false (legacy)', function () {
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
