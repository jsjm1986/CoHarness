import { describe, expect, it } from 'vitest'
import { requireSnapshotRecordKey, snapshotRecordPreflight } from './snapshot-preflight.ts'

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
