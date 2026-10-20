import { describe, it, expect } from 'vitest'
import { createZipArchive, crc32 } from './zipArchive.js'

describe('crc32', () => {
  it('matches the standard check value', () => {
    expect(crc32(Buffer.from('123456789', 'ascii'))).toBe(0xcbf43926)
  })
})

describe('createZipArchive', () => {
  const files = {
    'profile.json': Buffer.from('{"id":"u1"}'),
    'manifest.json': Buffer.from('{"schemaVersion":1}'),
  }

  it('writes local headers, a central directory and an end record', () => {
    const zip = createZipArchive(files)

    expect(zip.readUInt32LE(0)).toBe(0x04034b50)
    const eocd = zip.length - 22
    expect(zip.readUInt32LE(eocd)).toBe(0x06054b50)
    expect(zip.readUInt16LE(eocd + 8)).toBe(2)
    expect(zip.readUInt16LE(eocd + 10)).toBe(2)
  })

  it('stores each file with its name, length and CRC', () => {
    const zip = createZipArchive(files)
    const text = zip.toString('binary')

    for (const [name, data] of Object.entries(files)) {
      expect(text).toContain(name)
      expect(text).toContain(data.toString('binary'))
    }

    const first = zip.indexOf(Buffer.from('profile.json'))
    const localHeader = first - 30
    expect(zip.readUInt32LE(localHeader + 14)).toBe(crc32(files['profile.json']))
    expect(zip.readUInt32LE(localHeader + 18)).toBe(files['profile.json'].length)
  })

  it('points the central directory at the right local header offset', () => {
    const zip = createZipArchive(files)
    const eocd = zip.length - 22
    const cdOffset = zip.readUInt32LE(eocd + 16)
    expect(zip.readUInt32LE(cdOffset)).toBe(0x02014b50)
    const firstLocal = zip.readUInt32LE(cdOffset + 42)
    expect(firstLocal).toBe(0)
  })
})
