import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { testConfig } from './test-config.ts'
import { LocalNodeDrafts, type NodeDraftKey } from '../src/node-drafts.ts'
import type { RuntimeId, RuntimeNodeId } from '../src/runtime-catalog.ts'

it('keeps independently revisioned drafts on the exact owner, including across restart and lost responses', async () => {
  const root = mkdtempSync(join(tmpdir(), 'hgw-node-drafts-'))
  let store = new LocalNodeDrafts(root)
  const key: NodeDraftKey = { organizationId: 'org', nodeId: 'node-a' as RuntimeNodeId, userId: 1, runtimeId: 'a' as RuntimeId,
    target: 'personal', sessionId: 'same', draftId: 'tab-a' }
  const read = (k: NodeDraftKey) => store.apply(k, { kind: 'read' })
  const save = (revision: number, text: string) => store.apply(key, { kind: 'save', value: { revision, text } })
  try {
    expect(await read(key)).toEqual({ status: 200, value: { revision: 0, text: '' } })
    expect(await save(0, 'typing')).toEqual({ status: 200, value: { revision: 1, text: 'typing' } })
    await store.close()
    store = new LocalNodeDrafts(root)
    expect(await save(0, 'typing')).toEqual(await read(key))
    expect(await save(0, 'older')).toEqual({ status: 409 })
    for (const other of [{ userId: 2 }, { runtimeId: 'b' as RuntimeId }, { target: 'project:3' }, { sessionId: '' }, { draftId: 'tab-b' },
      { organizationId: 'org-b' }, { nodeId: 'node-b' as RuntimeNodeId }]) {
      expect(await read({ ...key, ...other })).toEqual({ status: 200, value: { revision: 0, text: '' } })
    }
    expect(await save(1, '')).toEqual({ status: 200, value: { revision: 2, text: '' } })
    expect(await store.apply(key,{kind:'read',revision:1})).toEqual({status:200,value:{revision:1,text:'typing',currentRevision:2}})
    for(const mismatch of [{userId:2},{runtimeId:'b' as RuntimeId},{draftId:'other'},{sessionId:'other'}]){
      expect(await store.apply({...key,...mismatch},{kind:'read',revision:1})).toEqual({status:410})
    }
    expect(await save(0, 'typing')).toEqual({ status: 409 })
  } finally { await store.close(); rmSync(root, { recursive: true, force: true }) }
})

it('retains only the configured predecessor count and serialized bytes, and keeps the current draft for a node restart', async () => {
  const root = mkdtempSync(join(tmpdir(), 'hgw-draft-history-'))
  const key: NodeDraftKey = { organizationId: 'org', nodeId: 'node' as RuntimeNodeId, userId: 1, runtimeId: 'r' as RuntimeId,
    target: 'personal', sessionId: 's', draftId: 'tab' }
  const limits = { revisions: 2, bytes: 100 }
  let store = new LocalNodeDrafts(root, undefined, limits)
  const pinned = (revision: number) => store.apply(key, { kind: 'read', revision })
  try {
    for (const [revision, text] of ['a', 'b', 'c', 'd', '界'.repeat(40)].entries()) {
      expect((await store.apply(key, { kind: 'save', value: { revision, text } })).status).toBe(200)
    }
    expect(await pinned(2)).toEqual({ status: 410 })
    expect(await pinned(3)).toEqual({ status: 200, value: { revision: 3, text: 'c', currentRevision: 5 } })
    await store.apply(key, { kind: 'save', value: { revision: 5, text: 'after large version' } })
    await store.close()
    store = new LocalNodeDrafts(root, undefined, limits)
    expect(await pinned(5)).toEqual({ status: 410 })
    expect(await pinned(6)).toEqual({ status: 200, value: { revision: 6, text: 'after large version', currentRevision: 6 } })
  } finally { await store.close(); rmSync(root, { recursive: true, force: true }) }
})

it('validates independent count and byte budgets before opening any node store', () => {
  const path = join(tmpdir(), 'hgw-parser-only-draft-budget')
  expect(testConfig(path).draftHistory).toEqual({ revisions: 16, bytes: 262144 })
  expect(testConfig(path, { HGW_DRAFT_HISTORY_REVISIONS: '3', HGW_DRAFT_HISTORY_BYTES: '4096' }).draftHistory)
    .toEqual({ revisions: 3, bytes: 4096 })
  expect(() => testConfig(path, { HGW_DRAFT_HISTORY_REVISIONS: '0' })).toThrow('HGW_DRAFT_HISTORY_REVISIONS')
  expect(() => testConfig(path, { HGW_DRAFT_HISTORY_BYTES: '-1' })).toThrow('HGW_DRAFT_HISTORY_BYTES')
})
