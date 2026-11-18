/**
 * Tests for the view-only RFB client→server filter: handshake parsing, frame
 * pass/drop decisions, chunked reassembly, and fail-closed rejection of
 * unparsable traffic.
 */

import { describe, expect, it } from 'vitest'
import { RemoteDesktopError } from '@deepseek-ai/dsh-remote-desktop'
import { RfbClientFilter } from '../src/rfb.ts'

function handshake(security: number, authBytes = 0): Buffer {
  return Buffer.concat([
    Buffer.from('RFB 003.008\n', 'latin1'),
    Buffer.from([security]),
    Buffer.alloc(authBytes, 0xaa),
    Buffer.from([1]),
  ])
}

const KEY_EVENT = Buffer.from([4, 1, 0, 0, 0, 0, 0, 0x61])
const POINTER_EVENT = Buffer.from([5, 1, 0, 10, 0, 20])
const FB_UPDATE_REQUEST = Buffer.from([3, 0, 0, 0, 0, 0, 4, 0, 3, 0])
const SET_ENCODINGS = Buffer.from([2, 0, 0, 1, 0, 0, 0, 0])
const CUT_TEXT = Buffer.concat([Buffer.from([6, 0, 0, 0, 0, 0, 0, 3]), Buffer.from('abc', 'latin1')])

describe('RfbClientFilter', () => {
  it('matches RFC 6143 message numbers through every byte-split boundary', () => {
    const pixelFormat = Buffer.alloc(20)
    const allowed = Buffer.concat([pixelFormat, SET_ENCODINGS, FB_UPDATE_REQUEST])
    const wire = Buffer.concat([pixelFormat, KEY_EVENT, SET_ENCODINGS, POINTER_EVENT, CUT_TEXT, FB_UPDATE_REQUEST])
    for (let split = 0; split <= wire.length; split++) {
      const filter = new RfbClientFilter('frame')
      const output = Buffer.concat([filter.push(wire.subarray(0, split)), filter.push(wire.subarray(split))])
      expect(output).toEqual(allowed)
      expect(filter.dropped).toBe(3)
    }
  })

  it('passes the handshake and negotiation frames through untouched', () => {
    const filter = new RfbClientFilter()
    const input = Buffer.concat([handshake(1), SET_ENCODINGS, FB_UPDATE_REQUEST])
    const out = filter.push(input)
    expect(out.equals(input)).toBe(true)
    expect(filter.dropped).toBe(0)
  })

  it('passes a VNC-auth handshake including its 16-byte response', () => {
    const filter = new RfbClientFilter()
    const input = Buffer.concat([handshake(2, 16), FB_UPDATE_REQUEST])
    expect(filter.push(input).equals(input)).toBe(true)
  })

  it('drops key, pointer, and clipboard frames while counting them', () => {
    const filter = new RfbClientFilter()
    const input = Buffer.concat([
      handshake(1),
      KEY_EVENT,
      POINTER_EVENT,
      CUT_TEXT,
      FB_UPDATE_REQUEST,
    ])
    const out = filter.push(input)
    expect(out.equals(Buffer.concat([handshake(1), FB_UPDATE_REQUEST]))).toBe(true)
    expect(filter.dropped).toBe(3)
  })

  it('reassembles frames split across chunk boundaries', () => {
    const filter = new RfbClientFilter()
    const input = Buffer.concat([handshake(2, 16), KEY_EVENT, FB_UPDATE_REQUEST])
    const out: Buffer[] = []
    for (const byte of input) out.push(filter.push(Buffer.from([byte])))
    expect(Buffer.concat(out).equals(Buffer.concat([handshake(2, 16), FB_UPDATE_REQUEST]))).toBe(true)
    expect(filter.dropped).toBe(1)
  })

  it('fails closed on an unknown message type', () => {
    const filter = new RfbClientFilter()
    expect(() => filter.push(Buffer.concat([handshake(1), Buffer.from([250, 0, 0, 0])]))).toThrow(RemoteDesktopError)
  })

  it('fails closed on a bad version preamble', () => {
    const filter = new RfbClientFilter()
    expect(() => filter.push(Buffer.from('XYZ 003.008\n'))).toThrow(RemoteDesktopError)
  })

  it('passes an Apple Remote Desktop handshake including its 192-byte response', () => {
    const filter = new RfbClientFilter()
    const input = Buffer.concat([handshake(30, 192), FB_UPDATE_REQUEST])
    expect(filter.push(input).equals(input)).toBe(true)
  })

  it('fails closed on a security type it cannot frame', () => {
    const filter = new RfbClientFilter()
    expect(() => filter.push(Buffer.concat([Buffer.from('RFB 003.008\n', 'latin1'), Buffer.from([16])]))).toThrow(RemoteDesktopError)
  })
})
