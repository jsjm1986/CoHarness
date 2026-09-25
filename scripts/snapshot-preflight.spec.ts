import { describe, expect, it } from 'vitest'
import { requireSnapshotRecordKey, snapshotRecordPreflight, webLiveRequested } from './snapshot-preflight.ts'

describe('snapshot record preflight', () => {
  it('accepts a non-empty key without exposing it', () => {
    expect(() => { requireSnapshotRecordKey({ DEEPSEEK_API_KEY: 'secret' }) }).not.toThrow()
  })

  it('rejects a missing or empty key with an actionable error', () => {
    expect(() => { requireSnapshotRecordKey({}) }).toThrow('snapshot record requires DEEPSEEK_API_KEY')
    expect(() => { requireSnapshotRecordKey({ DEEPSEEK_API_KEY: '' }) }).toThrow('snapshot record requires DEEPSEEK_API_KEY')
  })

  it('preflights the supplied environment before record work starts', () => {
    expect(() => { snapshotRecordPreflight({ DEEPSEEK_API_KEY: 'secret' }) }).not.toThrow()
    expect(() => { snapshotRecordPreflight({}) }).toThrow('snapshot record requires DEEPSEEK_API_KEY')
  })
})

it('does not select live Web verification from a key or a replay mode', () => {
  expect(webLiveRequested({ DEEPSEEK_API_KEY: 'ambient', DSH_SNAPSHOT: 'replay' })).toBe(false)
  expect(webLiveRequested({ DSH_WEB_LIVE: '1' })).toBe(true)
  for (const mode of ['record', 'replay', 'refresh']) {
    expect(() => webLiveRequested({ DSH_WEB_LIVE: '1', DSH_SNAPSHOT: mode })).toThrow('cannot run in a snapshot')
  }
  expect(() => webLiveRequested({ DSH_WEB_LIVE: 'yes' })).toThrow('must be 1 or unset')
})
