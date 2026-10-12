import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  MessageIdGenerator,
  buildActionFrame,
  buildCommandFrame,
  buildFrame,
  buildHeartbeatFrame,
  calculateChecksum,
  getDeviceProfile,
  isSupportedDeviceName,
  normalizeAddress,
  normalizeProfileName,
  uuidMatches,
  CMD_HEARTBEAT,
  CMD_LINEAR,
  CMD_ROTARY,
  CMD_VIBRATION,
} from '../src/chunfeng/protocol.js'

describe('protocol', () => {
  it('builds the documented vibration-20 frame', () => {
    // README: 01 02 00 03 08 14 E4
    const frame = buildActionFrame(1, 'vibration', 20)
    assert.deepEqual([...frame], [0x01, 0x02, 0x00, 0x03, 0x08, 0x14, 0xe4])
  })

  it('checksum is the two’s-complement of the payload sum', () => {
    assert.equal(calculateChecksum([0x08, 0x14]), 0xe4)
    assert.equal(calculateChecksum([0x00]), 0x00)
    assert.equal(calculateChecksum([0x01]), 0xff)
  })

  it('builds linear and rotary frames with the right command codes', () => {
    assert.equal(buildActionFrame(2, 'linear', 55)[4], CMD_LINEAR)
    assert.equal(buildActionFrame(2, 'rotary', 55)[4], CMD_ROTARY)
    assert.equal(buildActionFrame(2, 'vibration', 55)[4], CMD_VIBRATION)
  })

  it('heartbeat frame uses command 0xEF with value 0x01', () => {
    const frame = buildHeartbeatFrame(3)
    assert.equal(frame[0], 3)
    assert.equal(frame[4], CMD_HEARTBEAT)
    assert.equal(frame[5], 0x01)
    assert.equal(frame[6], calculateChecksum([CMD_HEARTBEAT, 0x01]))
  })

  it('rejects out-of-range message ids and levels', () => {
    assert.throws(() => buildFrame(0, 0x02, [1]))
    assert.throws(() => buildFrame(16, 0x02, [1]))
    assert.throws(() => buildActionFrame(1, 'vibration', -1))
    assert.throws(() => buildActionFrame(1, 'vibration', 101))
    assert.throws(() => buildActionFrame(1, 'vibration', 1.5))
    assert.throws(() => buildCommandFrame(1, 0x08, 300))
  })

  it('cycles message ids in 1..15 like the official client', () => {
    const ids = new MessageIdGenerator()
    const seen = Array.from({ length: 20 }, () => ids.next())
    assert.deepEqual(seen.slice(0, 15), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15])
    assert.deepEqual(seen.slice(15), [1, 2, 3, 4, 5])
    ids.reset()
    assert.equal(ids.next(), 1)
  })

  it('normalizes TF- aliases to DK- profile names', () => {
    assert.equal(normalizeProfileName('TF-META2'), 'DK-META2')
    assert.equal(normalizeProfileName('dk-meta2\0'), 'DK-META2')
    assert.equal(getDeviceProfile('TF-META2')?.name, 'DK-META2')
    assert.equal(getDeviceProfile('SOMETHING'), undefined)
  })

  it('recognizes supported device name prefixes', () => {
    assert.ok(isSupportedDeviceName('DK-META2'))
    assert.ok(isSupportedDeviceName('TF-X'))
    assert.ok(isSupportedDeviceName('TRYFUN-1'))
    assert.ok(!isSupportedDeviceName('ACME'))
    assert.ok(!isSupportedDeviceName(''))
    assert.ok(!isSupportedDeviceName(null))
  })

  it('normalizes BLE addresses', () => {
    assert.equal(normalizeAddress('aabbccddeeff'), 'AA:BB:CC:DD:EE:FF')
    assert.equal(normalizeAddress('AA:BB:CC:DD:EE:FF'), 'AA:BB:CC:DD:EE:FF')
    assert.equal(normalizeAddress('aa-bb-cc-dd-ee-ff'), 'AA:BB:CC:DD:EE:FF')
  })

  it('matches short and long UUID forms', () => {
    assert.ok(uuidMatches('ffb5', 'ffb5'))
    assert.ok(uuidMatches('0000FFB5-0000-1000-8000-00805F9B34FB', 'ffb5'))
    assert.ok(uuidMatches('0000ffac-0000-1000-8000-00805f9b34fb', 'ffac'))
    assert.ok(!uuidMatches('ffb7', 'ffb5'))
  })
})
