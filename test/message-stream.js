const assert = require('assert')
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
