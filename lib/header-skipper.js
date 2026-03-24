'use strict'

const { Transform } = require('node:stream')

function indexOfLF(buf) {
  for (let i = 0; i < buf.length; i++) {
    if (buf[i] === 0x0a) return i
  }
  return -1
}

// Strips everything from the start of a stored message up to and including
// the blank EOH line (\r\n or \n), then passes body bytes through unchanged.
class HeaderSkipper extends Transform {
  #remainder = Buffer.alloc(0)
  #eohFound = false

  _transform(chunk, enc, cb) {
    if (this.#eohFound) {
      this.push(chunk)
      return cb()
    }
    let buf = Buffer.concat([this.#remainder, chunk])
    let offset
    while ((offset = indexOfLF(buf)) !== -1) {
      const line = buf.slice(0, offset + 1)
      buf = buf.slice(offset + 1)
      const isEoh =
        (line.length === 2 && line[0] === 0x0d && line[1] === 0x0a) ||
        (line.length === 1 && line[0] === 0x0a)
      if (isEoh) {
        this.#eohFound = true
        if (buf.length > 0) this.push(buf)
        this.#remainder = Buffer.alloc(0)
        return cb()
      }
    }
    this.#remainder = buf
    cb()
  }

  _flush(cb) {
    // Any remainder after EOF with no EOH found is discarded (headers-only msg edge case)
    if (this.#remainder.length > 0 && this.#eohFound) this.push(this.#remainder)
    cb()
  }
}

module.exports = HeaderSkipper
