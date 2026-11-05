/** Wire-level draft receipts and tab-local recovery under duplicate tabs and lost acknowledgements. */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { NodeDraft, type NodeDraftOwner } from '../src/client/node-draft.ts'

const owner = { accountId: 7, target: { kind: 'personal', runtimeId: '11111111-1111-4111-8111-111111111111' },
  sessionId: 'same-session', requestTimeoutMs: 2000 } as NodeDraftOwner
afterEach(() => { vi.unstubAllGlobals() })

function installLocks() {
  const holders = new Set<string>()
  vi.stubGlobal('navigator', { locks: { request: async (name: string, _options: unknown, run: (lock: unknown) => Promise<void>) => {
    if (holders.has(name)) return run(null)
    holders.add(name)
    try { await run({ name }) } finally { holders.delete(name) }
  } } })
  return holders
}

function setup() {
  const records = new Map<string, { revision: number; text: string }>()
  const versions = new Map<string, { revision: number; text: string }>()
  const storage = new Map<string, string>()
  let tab = storage
  const wires: string[] = []
  let drop = false
  vi.stubGlobal('location', new URL('https://unit.invalid/'))
  vi.stubGlobal('sessionStorage', { getItem: (k: string) => tab.get(k) ?? null,
    setItem: (k: string, v: string) => tab.set(k, v), removeItem: (k: string) => tab.delete(k) })
  const fetcher = vi.fn(async (url: URL, init: RequestInit) => {
    expect(url.searchParams.get('sessionId')).toBe('same-session')
    expect(url.searchParams.get('dshRuntime')).toBe(owner.target.runtimeId)
    expect(new Headers(init.headers).get('x-dsh-expected-principal-id')).toBe('7')
    wires.push(init.method ?? 'GET')
    const row = records.get(url.pathname) ?? { revision: 0, text: '' }
    const headers = { 'x-dsh-runtime-id': owner.target.runtimeId! }
    if (init.method === 'GET') {
      const version = url.searchParams.get('revision')
      if (version === null) return Response.json(row, { headers })
      const found = Number(version) === row.revision ? row : versions.get(url.pathname + ':' + version)
      return found ? Response.json({ ...found, currentRevision: row.revision }, { headers }) : new Response(null, { status: 410 })
    }
    const body = JSON.parse(typeof init.body === 'string' ? init.body : '') as { revision: number; text?: string }
    if (body.revision !== row.revision) return new Response(null, { status: 409 })
    if (row.revision) versions.set(`${url.pathname}:${String(row.revision)}`, row)
    const next = { revision: row.revision + 1, text: body.text ?? '' }
    records.set(url.pathname, next)
    if (drop) { drop = false; throw new Error('acknowledgement lost') }
    return Response.json(next, { headers })
  })
  vi.stubGlobal('fetch', fetcher)
  return { wires, records, storage, versions, fetcher, switchTab: (area: Map<string, string>) => { tab = area },
    loseReceipt: () => { drop = true } }
}

describe('node-owned drafts', () => {
  it('retains memory after a lost receipt and reads back the exact version before writing subsequent edits', async () => {
    const server = setup()
    const writer = new NodeDraft(owner, 'opaque', () => {}, () => {})
    await writer.settle()
    server.loseReceipt()
    writer.write('private-1')
    await writer.settle()
    expect(writer.unsynchronized).toBe(true)
    expect(server.storage.size).toBe(0)
    writer.write('private-2')
    expect(server.wires).toEqual(['PUT'])
    await writer.retry()
    expect(server.wires).toEqual(['PUT', 'GET', 'PUT'])
    expect(writer.canRestore('private-2')).toBe(true)
    expect([...server.storage.values()].join(' ')).not.toContain('private')
    writer.dispose()
  })

  it('reopens the same node row after an exclusive writer exits and clears its actual content', async () => {
    const server = setup()
    const holders = installLocks()
    const first = new NodeDraft(owner, 'opaque', () => {}, () => {})
    await first.settle()
    first.write('private')
    await first.settle()
    first.dispose()
    await vi.waitFor(() => { expect(holders.size).toBe(0) })
    const restored = vi.fn()
    const reopened = new NodeDraft(owner, 'opaque', restored, () => {})
    await reopened.settle()
    expect(restored).toHaveBeenCalledWith('private')
    reopened.write('')
    await reopened.settle()
    expect([...server.records.values()]).toEqual([{ revision: 2, text: '' }])
    expect(server.storage.size).toBe(0)
    reopened.dispose()
  })

  it('recovers the copied tab’s acknowledged draft after the original edits and the unedited copy reloads', async () => {
    const server = setup()
    const first = new NodeDraft(owner, 'opaque', () => {}, () => {})
    await first.settle()
    first.write('original revision')
    await first.settle()
    const copied = new Map(server.storage)
    server.switchTab(copied)
    const second = new NodeDraft(owner, 'opaque', () => {}, () => {})
    await second.settle()
    server.switchTab(server.storage)
    first.write('new text on the first tab')
    await first.settle()
    server.switchTab(copied)
    expect(second.canRestore('original revision')).toBe(true)
    second.dispose()
    const restored = vi.fn()
    const reload = new NodeDraft(owner, 'opaque', restored, () => {})
    await reload.settle()
    expect(restored).toHaveBeenCalledWith('original revision')
    first.dispose(); reload.dispose()
  })

  it('makes the original composer ready when the user retries an initially offline source read', async () => {
    const server = setup()
    const id = '40000000-0000-4000-8000-000000000002'
    server.storage.set('opaque.node-draft.v1', id)
    server.records.set('/account/api/drafts/' + id, { revision: 1, text: 'retained text' })
    server.fetcher.mockRejectedValueOnce(new Error('offline'))
    const restored = vi.fn()
    const writer = new NodeDraft(owner, 'opaque', restored, () => {})
    await writer.restore()
    expect(writer.sourceReady).toBe(false)
    await writer.restore()
    expect(writer.sourceReady).toBe(true)
    expect(restored).toHaveBeenCalledWith('retained text')
    writer.dispose()
  })

  it('reads the pinned predecessor when the sibling edits before the copied document can first read, and writes independently both ways', async () => {
    const server = setup()
    const first = new NodeDraft(owner, 'opaque', () => {}, () => {})
    await first.settle()
    first.write('first receipt')
    await first.settle()
    const copied = new Map(server.storage)
    first.write('second receipt')
    await first.settle()
    server.switchTab(copied)
    const restore = vi.fn()
    const duplicate = new NodeDraft(owner, 'opaque', restore, () => {})
    server.loseReceipt()
    await duplicate.settle()
    expect(restore).toHaveBeenCalledWith('first receipt')
    expect(duplicate.canRestore('first receipt')).toBe(false)
    expect(duplicate.unsynchronized).toBe(true)
    await duplicate.retry()
    expect(duplicate.canRestore('first receipt')).toBe(true)
    expect(copied.get('opaque.node-draft.v1')?.split('@')[0]).not.toBe(server.storage.get('opaque.node-draft.v1')?.split('@')[0])
    duplicate.write('independent')
    await duplicate.settle()
    server.switchTab(server.storage)
    expect(first.canRestore('second receipt')).toBe(true)
    expect([...server.records.values()].map(row => row.text).sort()).toEqual(['independent', 'second receipt'])
    first.dispose(); duplicate.dispose()
  })

  it.each([true, false])('retains the exact copy after the original updates and closes before first read (Web Locks %s)', async (withLocks) => {
    const server = setup()
    const holders = withLocks ? installLocks() : undefined
    if (!withLocks) vi.stubGlobal('navigator', {})
    const first = new NodeDraft(owner, 'opaque', () => {}, () => {})
    await first.settle(); first.write('copy-time value'); await first.settle()
    const copied = new Map(server.storage)
    first.write('last value in original')
    await first.settle()
    first.dispose()
    if (holders) await vi.waitFor(() => { expect(holders.size).toBe(0) })
    server.switchTab(copied)
    const restored = vi.fn(), fork = new NodeDraft(owner, 'opaque', restored, () => {})
    await fork.settle()
    expect(restored).toHaveBeenCalledWith('copy-time value')
    expect(fork.canRestore('copy-time value')).toBe(true)
    expect([...server.records.values()].map(row => row.text).sort()).toEqual(['copy-time value', 'last value in original'])
    fork.dispose()
  })

  it('does not publish a matching body from the wrong revision after a lost write receipt', async () => {
    const server = setup()
    const writer = new NodeDraft(owner, 'opaque', () => {}, () => {})
    await writer.settle()
    server.loseReceipt()
    writer.write('same text in unrelated edit')
    await writer.settle()
    const [id] = server.records.keys()
    server.records.set(id!, { revision: 4, text: 'same text in unrelated edit' })
    await writer.retry()
    expect(writer.unsynchronized).toBe(true)
    expect(server.storage.size).toBe(0)
    writer.dispose()
  })

  it('preserves the pinned pointer and local input when history expires, access is denied, or an older node returns its current version', async () => {
    for (const fault of ['expired', 'denied', 'older', 'wrong-owner'] as const) {
      const server = setup()
      const id = '40000000-0000-4000-8000-000000000002'
      server.storage.set('opaque.node-draft.v1', id + '@2')
      if (fault === 'denied') server.fetcher.mockResolvedValueOnce(new Response(null, { status: 403 }))
      if (fault === 'older' || fault === 'wrong-owner') server.fetcher.mockResolvedValueOnce(Response.json({
        revision: fault === 'older' ? 3 : 2, text: 'other data',
      }, { headers: { 'x-dsh-runtime-id': fault === 'older' ? owner.target.runtimeId! : id } }))
      const restored = vi.fn()
      const writer = new NodeDraft(owner, 'opaque', restored, () => {})
      writer.write('typed here')
      await writer.settle()
      expect(writer.sourceReady).toBe(false)
      expect(writer.versionUnavailable).toBe(fault === 'expired' || fault === 'older')
      expect(writer.unsynchronized).toBe(true)
      expect(restored).not.toHaveBeenCalled()
      expect(server.storage.get('opaque.node-draft.v1')).toBe(id + '@2')
      expect(server.records.size).toBe(0)
      writer.dispose()
    }
  })

  it('reads a duplicated pointer once then forks the writer so the first tab retains its draft', async () => {
    const server = setup()
    const first = new NodeDraft(owner, 'opaque', () => {}, () => {})
    await first.settle()
    first.write('base')
    await first.settle()
    const copyValue = vi.fn()
    const duplicate = new NodeDraft(owner, 'opaque', copyValue, () => {})
    await duplicate.settle()
    expect(copyValue).toHaveBeenCalledWith('base')
    duplicate.write('duplicate')
    await duplicate.settle()
    first.write('original')
    await first.settle()
    expect([...server.records.values()].map(row => row.text).sort()).toEqual(['duplicate', 'original'])
    expect([...server.storage.values()][0]).toMatch(/^[\da-f-]{36}@[1-9]\d*$/u)
    first.dispose(); duplicate.dispose()
  })
})
