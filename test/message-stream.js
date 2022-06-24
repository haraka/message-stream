
const assert = require('assert')
const stream = require('stream')

const MessageStream = require('../index')

function _set_up () {
  this.ms = new MessageStream({ main: { } }, 'msg', []);
}

describe('message-stream', function () {

  beforeEach(_set_up)

  it('is a Stream', function (done) {
    assert.ok(this.ms instanceof MessageStream);
    assert.ok(this.ms instanceof stream.Stream);
    done()
  })

  it('gets message data', function (done) {
    this.ms.add_line('Header: test\r\n');
    this.ms.add_line('\r\n');
    this.ms.add_line('I am body text\r\n');
    this.ms.add_line_end();
    this.ms.get_data((data) => {
      assert.ok(/^[A-Za-z]+: /.test(data.toString()))
      done()
    })
  })
})
