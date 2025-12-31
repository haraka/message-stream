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
