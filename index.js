'use strict'

const fs = require('node:fs')
const path = require('node:path')
const { Stream, PassThrough, Writable } = require('node:stream')

const ChunkEmitter = require('./lib/chunk-emitter')
const HeaderSkipper = require('./lib/header-skipper')
const LineTransformer = require('./lib/line-transformer')

const STATE = { HEADERS: 1, BODY: 2 }
const MAX_IDX_KEYS = 1000

class MessageStream extends Stream {
  // Public observable state
  uuid
  bytes_read = 0
  state = STATE.HEADERS
  idx = {}
  spooling = false
  buffered = 0
  total_buffered = 0
  max_data_inflight = 0
  headers

  // Private write-side state
  #queue = []
  #writeCe = null
  #fd = null
  #ws = null
  #openPending = false
  #writePending = false
  #writeComplete = false
  #wsEnded = false
  #endCalled = false
  #endCallback = null
  #idxCount = 0

  // Private read-side state
  #inPipe = false
  #currentSource = null

  // Config
  #bufferMax
  #spoolDir
  #filename

  constructor(cfg = {}, id, headers) {
    super()
    if (!id) throw new Error('id required')
    this.uuid = id
    this.headers = headers ?? []
    this.#bufferMax = !isNaN(cfg?.main?.spool_after)
      ? Number(cfg.main.spool_after)
      : -1
    this.#spoolDir = cfg?.main?.spool_dir ?? '/tmp'
    this.#filename = path.join(this.#spoolDir, `${path.basename(id)}.eml`)
  }

  // ── Write side ────────────────────────────────────────────────────────────

  add_line(line) {
    if (typeof line === 'string') line = Buffer.from(line)

    if (!this.#writeCe) {
      this.#writeCe = new ChunkEmitter()
      this.#writeCe.on('data', (chunk) => this.#write(chunk))
    }

    this.bytes_read += line.length

    // Build up an index of 'interesting' data on the fly
    if (this.state === STATE.HEADERS) {
      // Look for end of headers line
      if (line.length === 2 && line[0] === 0x0d && line[1] === 0x0a) {
        this.idx.headers = { start: 0, end: this.bytes_read - line.length }
        this.#idxCount++
        this.state = STATE.BODY
        this.idx.body = { start: this.bytes_read }
        this.#idxCount++
      }
    }

    if (this.state === STATE.BODY) {
      // Look for MIME boundaries
      if (line.length > 4 && line[0] === 0x2d && line[1] === 0x2d) {
        let boundary = line.slice(2).toString().trimEnd()
        if (/--\s*$/.test(line)) {
          boundary = boundary.slice(0, -2)
          if (this.idx[boundary]) this.idx[boundary].end = this.bytes_read
        } else {
          if (!this.idx[boundary] && this.#idxCount < MAX_IDX_KEYS) {
            this.idx[boundary] = { start: this.bytes_read - line.length }
            this.#idxCount++
          }
        }
      }
    }

    this.#writeCe.fill(line)
  }

  add_line_end(cb) {
    if (this.idx.body) this.idx.body.end = this.bytes_read
    this.#endCalled = true
    if (typeof cb === 'function') this.#endCallback = cb
    // Call _write() only if no new data was emitted This might happen if the
    // message size matches the size of the chunk buffer.
    if (!this.#writeCe.end()) this.#write()
  }

  #write(data) {
    if (data) {
      this.buffered += data.length
      this.total_buffered += data.length
      this.#queue.push(data)
    }
    if (this.buffered > this.max_data_inflight)
      this.max_data_inflight = this.buffered

    if (this.#openPending || this.#writePending) return false

    if (this.#bufferMax !== -1 && this.total_buffered > this.#bufferMax)
      this.spooling = true

    if (this.#endCalled && (!this.spooling || !this.#queue.length)) {
      if (this.spooling && this.#ws && !this.#wsEnded) {
        // SUNSET 2027 (node 20 exits LTS on 2026-04-18)
        // see test: 'spool file is fully written before add_line_end callback fires'
        this.#wsEnded = true
        this.#ws.end(() => {
          this.#endCallback?.()
          if (!this.#writeComplete) {
            this.#writeComplete = true
            this.emit('_write_complete')
          }
        })
      } else if (!this.#wsEnded) {
        this.#endCallback?.()
        if (!this.#writeComplete) {
          this.#writeComplete = true
          this.emit('_write_complete')
        }
      }
      return true
    }

    if (
      this.#bufferMax === -1 ||
      (this.buffered < this.#bufferMax && !this.spooling)
    ) {
      return true
    }

    if (!this.#queue.length) return false

    // Open spool file if needed
    if (!this.#fd && !this.#openPending) {
      this.#openPending = true
      this.#ws = fs.createWriteStream(this.#filename, {
        flags: 'wx+',
        autoClose: false,
      })
      this.#ws.on('open', (fd) => {
        this.#fd = fd
        this.#openPending = false
        setImmediate(() => this.#write())
      })
      this.#ws.on('error', (err) => this.emit('error', err))
    }

    if (!this.#fd) return false

    const toSend = this.#queue.shift()
    this.buffered -= toSend.length

    if (!this.#ws.write(toSend)) {
      this.#writePending = true
      this.#ws.once('drain', () => {
        this.#writePending = false
        setImmediate(() => this.#write())
      })
      return false
    }

    if (this.#endCalled && (!this.spooling || !this.#queue.length))
      return this.#write()
    return true
  }

  // ── Read side ─────────────────────────────────────────────────────────────

  pipe(destination, options = {}) {
    if (this.#inPipe) throw new Error('Cannot pipe while currently piping')

    const lineEndings = options?.line_endings ?? '\r\n'
    const skipHeaders = !!options?.skip_headers

    this.#inPipe = true

    const transformer = new LineTransformer({
      lineEndings,
      dotStuffed: options?.dot_stuffed ?? true,
      endingDot: options?.ending_dot ?? false,
      clamdStyle: !!options?.clamd_style,
    })
    const source = new PassThrough()
    this.#currentSource = source

    // Register before pipe() so these fire before the pipe's own 'end' handler,
    // which calls destination.end() — potentially triggering a synchronous next()
    // that would attempt a new pipe() while #inPipe is still true.
    transformer.once('end', () => {
      this.#inPipe = false
    })
    transformer.once('error', (err) => {
      this.#inPipe = false
      this.emit('error', err)
    })
    source.once('error', (err) => this.emit('error', err))

    source.pipe(transformer).pipe(destination, { end: options.end !== false })

    // Constructor headers suppress raw-data headers; skip_headers also suppresses ctor headers
    const emitCtorHeaders = this.headers.length > 0 && !skipHeaders
    const skipRawHeaders = this.headers.length > 0 || skipHeaders

    const doRead = () => {
      if (emitCtorHeaders) {
        for (const h of this.headers) {
          source.write(Buffer.from(h.replace(/\r?\n/g, lineEndings)))
        }
        source.write(Buffer.from(lineEndings)) // EOH marker
      }

      if (this.#queue.length > 0) {
        // In-memory path
        if (skipRawHeaders) {
          const skipper = new HeaderSkipper()
          skipper.on('error', (err) => source.destroy(err))
          skipper.pipe(source)
          for (const chunk of this.#queue) skipper.write(chunk.slice(0))
          skipper.end()
        } else {
          for (const chunk of this.#queue) source.write(chunk.slice(0))
          source.end()
        }
      } else {
        // Disk path
        const startRead = (fd) => {
          const rs = fs.createReadStream(null, { fd, start: 0 })
          // Prevent the fd from being closed so it can be reused across sequential pipes
          rs.destroy = () => {}
          rs.once('error', (err) => {
            source.destroy(err)
            this.emit('error', err)
          })
          if (skipRawHeaders) {
            const skipper = new HeaderSkipper()
            skipper.on('error', (err) => source.destroy(err))
            rs.pipe(skipper).pipe(source)
          } else {
            rs.pipe(source)
          }
        }

        if (this.#fd) {
          startRead(this.#fd)
        } else {
          fs.open(this.#filename, 'r', (err, fd) => {
            if (err) {
              this.emit('error', err)
              source.destroy(err)
              return
            }
            this.#fd = fd
            startRead(fd)
          })
        }
      }
    }

    if (this.#writeComplete) {
      doRead()
    } else {
      this.once('_write_complete', doRead)
    }

    return destination
  }

  pause() {
    this.#currentSource?.pause()
  }

  resume() {
    this.#currentSource?.resume()
  }

  destroy() {
    try {
      if (this.#fd) {
        fs.close(this.#fd, () => fs.unlink(this.#filename, () => {}))
      } else {
        fs.unlink(this.#filename, () => {})
      }
    } catch {
      // ignore
    }
  }

  get_data(options, cb) {
    if (arguments.length === 1) {
      cb = options
      options = {}
    }
    this.pipe(new GetDataStream(cb), options)
  }

  [Symbol.asyncIterator](options = {}) {
    const pass = new PassThrough()
    this.pipe(pass, options)
    return pass[Symbol.asyncIterator]()
  }
}

module.exports = MessageStream

class GetDataStream extends Writable {
  constructor(cb) {
    super()
    this.cb = cb
    this.chunks = []
  }

  _write(chunk, _enc, done) {
    this.chunks.push(chunk)
    done()
  }

  _final(done) {
    this.cb(Buffer.concat(this.chunks))
    done()
  }
}

module.exports.ChunkEmitter = ChunkEmitter
