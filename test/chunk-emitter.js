
const assert   = require('assert')
const fs       = require('fs')
const path     = require('path')

const ChunkEmitter = require('../index').ChunkEmitter

describe('chunk-emitter', function () {

  beforeEach(function () {
    this.ce = new ChunkEmitter()
    this._written = 0
  })

  it('loads', function () {
    assert.ok(this.ce)
  })

  it('emits all unbuffered bytes', function (done) {
    const msgPath = path.join(__dirname, 'fixtures', 'haraka-icon-attach.eml')
    const eml = fs.readFileSync(msgPath, 'utf8');

    this._write = (data) => {
      this._written = (this._written || 0) + data.length
      if (eml.length === this._written) {
        assert.equal(eml.length, this._written)
        done()
      }
    }

    this.ce.on('data', chunk => {
      this._write(chunk);
    })

    this.ce.fill(eml)
    this.ce.end()
  })

  it('emits all bigger than buffer bytes', function (done) {
    const msgPath = path.join(__dirname, 'fixtures', 'haraka-tarball-attach.eml')
    // console.log(`msgPath: ${msgPath}`)
    const eml = fs.readFileSync(msgPath, 'utf8');
    // console.log(`length: ${eml.length}`)

    this._write = (data) => {
      // console.log(`_write: ${data.length} bytes`)
      this._written = this._written + data.length
      // console.log(`_written: ${this._written}`)
      if (eml.length === this._written) {
        assert.equal(eml.length, this._written)
        // console.log(this.ce)
        done()
      }
    }

    this.ce.on('data', chunk => {
      // console.log(`ce.on.data: ${chunk.length} bytes`)
      this._write(chunk);
    })

    this.ce.fill(eml)
    this.ce.end()
  })
})
