'use strict'

const { Transform } = require('node:stream')

function indexOfLF(buf) {
  for (let i = 0; i < buf.length; i++) {
    if (buf[i] === 0x0a) return i
  }
  return -1
}

// Per-line transformer: dot-unstuffing, line-ending normalisation,
// optional ending-dot, optional clamd-style size framing.
class LineTransformer extends Transform {
  #remainder = Buffer.alloc(0)
  #lineEndings
  #dotStuffed
  #endingDot
  #clamdStyle

  constructor({
    lineEndings = '\r\n',
    dotStuffed = true,
    endingDot = false,
    clamdStyle = false,
  } = {}) {
    super()
    this.#lineEndings = lineEndings
    this.#dotStuffed = dotStuffed
    this.#endingDot = endingDot
    this.#clamdStyle = clamdStyle
  }

  #pushLine(line) {
    if (this.#clamdStyle) {
      const buf = Buffer.allocUnsafe(line.length + 4)
      buf.writeUInt32BE(line.length, 0)
      line.copy(buf, 4)
      this.push(buf)
    } else {
      this.push(line)
    }
  }

  #transformLine(line) {
    // Remove SMTP dot-stuffing: leading '..' → '.'
    if (
      this.#dotStuffed &&
      line.length >= 2 &&
      line[0] === 0x2e &&
      line[1] === 0x2e
    ) {
      line = line.slice(1)
    }
    // Strip \r when consumer wants bare-LF line endings
    if (
      this.#lineEndings === '\n' &&
      line.length >= 2 &&
      line[line.length - 1] === 0x0a &&
      line[line.length - 2] === 0x0d
    ) {
      const copy = Buffer.allocUnsafe(line.length - 1)
      line.copy(copy, 0, 0, line.length - 2)
      copy[copy.length - 1] = 0x0a
      line = copy
    }
    this.#pushLine(line)
  }

  _transform(chunk, enc, cb) {
    let buf = Buffer.concat([this.#remainder, chunk])
    let offset
    while ((offset = indexOfLF(buf)) !== -1) {
      this.#transformLine(buf.slice(0, offset + 1))
      buf = buf.slice(offset + 1)
    }
    this.#remainder = buf
    cb()
  }

  _flush(cb) {
    if (this.#remainder.length > 0) {
      this.#transformLine(this.#remainder)
      this.#remainder = Buffer.alloc(0)
    }
    if (this.#endingDot) {
      this.#pushLine(Buffer.from(`.${this.#lineEndings}`))
    }
    if (this.#clamdStyle) {
      const term = Buffer.alloc(4)
      term.writeUInt32BE(0, 0)
      this.push(term)
    }
    cb()
  }
}

module.exports = LineTransformer
