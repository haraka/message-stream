const assert = require('assert')
const { describe, it } = require('node:test')
const fs = require('fs')
const path = require('path')

const ChunkEmitter = require('../index').ChunkEmitter

describe('chunk-emitter', function () {
  it('emits all unbuffered bytes', async () => {
    const msgPath = path.join(__dirname, 'fixtures', 'haraka-icon-attach.eml')
    const eml = fs.readFileSync(msgPath, 'utf8')

    let written = 0

    const ce = new ChunkEmitter()

    const dataPromise = new Promise((resolve) => {
      ce.on('data', (chunk) => {
        written += chunk.length
        if (written === eml.length) {
          resolve(written)
        }
      })
    })

    ce.fill(eml)
    ce.end()

    const total = await dataPromise
    assert.equal(total, eml.length)
  })

  it('emits all bigger than buffer bytes', async () => {
    const msgPath = path.join(
      __dirname,
      'fixtures',
      'haraka-tarball-attach.eml',
    )
    const eml = fs.readFileSync(msgPath, 'utf8')

    let written = 0

    const ce = new ChunkEmitter()

    const dataPromise = new Promise((resolve) => {
      ce.on('data', (chunk) => {
        written += chunk.length
        if (written === eml.length) {
          resolve(written)
        }
      })
    })

    ce.fill(eml)
    ce.end()

    const total = await dataPromise
    assert.equal(total, eml.length)
  })
})
