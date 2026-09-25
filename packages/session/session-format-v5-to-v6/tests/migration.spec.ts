import { expect, it } from 'vitest'
import { SessionFormatEventCollector, type SessionFormatHeader } from '@deepseek-ai/dsh-session-format'
import { assertReleasedV6Header, releasedV5SessionFormatCodec, releasedV6SessionFormatCodec, restoreReleasedV6Artifact, sessionFormatV5ToV6 } from '../src/index.ts'

const header: SessionFormatHeader = { version: 5, id: 'ssh-target-upgrade', createdAt: 1, isSeeded: false, delegationDepth: 0 }

it.each([undefined, 41])('preserves an already-written sshTarget=%j binding while promoting only the version', (sshTarget) => {
  const source = { ...header, ...sshTarget === undefined ? {} : { sshTarget } }
  const physical = releasedV5SessionFormatCodec.encodeHeader(source, 0)
  expect(physical).toEqual({ type: 'session', ...source })
  const target = sessionFormatV5ToV6.migrateHeader(releasedV5SessionFormatCodec.decodeHeader(physical))
  expect(target).toEqual({ ...source, version: 6 })
  expect(releasedV6SessionFormatCodec.decodeHeader(releasedV6SessionFormatCodec.encodeHeader(target, 0))).toEqual(target)
  for (const bad of ['41', 0, -1, 1.5]) {
    expect(() => releasedV6SessionFormatCodec.decodeHeader({ type: 'session', ...header, version: 6, sshTarget: bad as number }))
      .toThrow('sshTarget must be a positive safe integer')
    expect(() => { assertReleasedV6Header({ ...header, version: 6, sshTarget: bad }) })
      .toThrow('sshTarget must be a positive safe integer')
  }
})

it.each([undefined, false, true])('preserves already-written draft=%j while promoting only the version', (draft) => {
  const source = { ...header, ...draft === undefined ? {} : { draft } }
  const physical = releasedV5SessionFormatCodec.encodeHeader(source, 0)
  expect(physical).toEqual({ type: 'session', ...source })
  const target = sessionFormatV5ToV6.migrateHeader(releasedV5SessionFormatCodec.decodeHeader(physical))
  expect(target).toEqual({ ...source, version: 6 })
  const encoded = releasedV6SessionFormatCodec.encodeHeader(target, 0)
  expect(encoded).toEqual({ ...physical, version: 6 })
  expect(releasedV6SessionFormatCodec.decodeHeader(encoded)).toEqual(target)
  const decoder = releasedV6SessionFormatCodec.createDecoder(encoded, 'strict')
  const collector = new SessionFormatEventCollector()
  const row = { seq: 0, time: 1, type: 'turn/start', data: { turn: 1 } }
  const event = releasedV6SessionFormatCodec.encodeEvent(row)
  decoder.decodeRow(event, collector)
  expect(collector.values).toEqual([row])
  expect(decoder.finish(collector)).toBe(0)
  expect(restoreReleasedV6Artifact({ header: target, events: [], inheritedEventCount: 0 }, new Set()).header).toBe(target)
})
