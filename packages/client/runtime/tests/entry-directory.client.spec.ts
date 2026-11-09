/** Cold discovery and explicit node pages do not enumerate or start other computers. */
import { afterEach, expect, it, vi } from 'vitest'
import { EntryDirectory } from '../src/client/entry-directory.ts'
import type { SessionRuntimeTarget } from '../src/client/contract/sessions.ts'

const id = (prefix: number, i: number) => `${prefix}0000000-0000-4000-8000-${String(i).padStart(12, '0')}`
const rows = Array.from({ length: 20 }, (_, i) => ({ id: id(1, i + 1), owner: { kind: 'personal', id: 7, name: 'A' },
  node: { id: id(2, i + 1), name: `Computer ${i + 1}`, status: 'active' }, observedState: 'stopped' }))
const target = (i: number) => ({ kind: 'personal', runtimeId: rows[i]!.id } as SessionRuntimeTarget)
afterEach(() => { vi.unstubAllGlobals() })

it('resolves a selected authorized project outside the first page and rejects an unfiltered or reassigned allocation', async () => {
  vi.stubGlobal('location', new URL('https://harness.invalid'))
  const known = rows[0]!, node = rows[1]!.node, allocation = { id: id(3, 17),
    owner: { kind: 'project', id: 17, name: 'Known project' }, node, observedState: 'stopped' }
  let returned = [allocation]
  const read = vi.fn(async (path: string) => {
    if (path === '/account/api/runtimes') return { items: [known], nextCursor: 'two-hundred-more' }
    if (path.startsWith('/account/api/context?')) return { user: { id: 7, displayName: 'A' }, environment: { id: known.id },
      projects: [{ projectId: 17, nodeId: node.id, name: 'Known project' }] }
    if (path === '/account/api/runtimes?projectId=17') return { items: returned, nextCursor: null }
    throw new Error('An unselected computer was contacted')
  })
  const directory = new EntryDirectory(read)
  await directory.manifest(7, target(0))
  expect(await directory.selection('999', 7)).toBeUndefined()
  expect(read).toHaveBeenCalledTimes(2)
  returned = [known, allocation]
  await expect(directory.selection('17', 7)).rejects.toThrow('different allocation')
  returned = [{ ...allocation, node: known.node }]
  await expect(directory.selection('17', 7)).rejects.toThrow('different allocation')
  returned = []
  expect(await directory.selection('17', 7)).toBeUndefined()
  returned = [allocation]
  expect(await directory.selection('17', 7)).toMatchObject({ kind: 'project', projectId: 17, runtimeId: allocation.id, nodeId: node.id })
  expect(await directory.selection('17', 7)).toBe(directory.target('17'))
  expect(read).toHaveBeenCalledTimes(6)
})

it('searches only retained, currently authorized rows and keeps each selected search cursor with its owner', async () => {
  vi.stubGlobal('location', new URL('https://harness.invalid'))
  const primary = target(0), remote = target(1)
  const project = { kind: 'project', projectId: 9, runtimeId: id(3, 1) } as SessionRuntimeTarget
  const projectRow = { ...rows[1]!, id: project.runtimeId, owner: { kind: 'project', id: 9, name: 'Team' } }
  const held = Promise.withResolvers<undefined>()
  let revoked = false
  const read = vi.fn(async (path: string) => {
    const url = new URL(path, 'https://harness.invalid')
    if (url.pathname === '/account/api/runtimes') return { items: revoked ? [rows[0]] : [...rows, projectRow], nextCursor: null }
    if (url.pathname === '/account/api/context') return { user: { id: 7, displayName: 'A' }, environment: { id: primary.runtimeId },
      projects: revoked ? [] : [{ projectId: 9, name: 'Team' }] }
    const selected = [primary, remote, project].find(item => item.runtimeId === url.searchParams.get('dshRuntime'))
    if (selected === undefined) throw new Error('Unselected computer')
    const q = url.searchParams.get('q'), cursor = url.searchParams.get('cursor')
    if (q === 'held') await held.promise
    if (q === 'denied') throw Object.assign(new Error('Forbidden'), { status: 403 })
    return { runtimeId: selected.runtimeId, nextCursor: q && !cursor ? 'owner-page-two' : null, workspaces: [],
      items: [{ sessionId: cursor ? 'page-two' : 'same-id', runtime: selected,
        title: cursor ? 'Previously undiscovered' : selected.kind === 'project' ? 'Release review' : 'Personal notes' }] }
  })
  const directory = new EntryDirectory(read)
  await directory.manifest(7, primary)
  for (const owner of [primary, remote, project]) await directory.rows(owner, { kind: 'conversations' })
  const calls = read.mock.calls.length
  expect(directory.snapshot({ scope: '', q: 'review' })).toMatchObject({ scopePartial: true,
    items: [{ sessionId: 'same-id', runtime: project }] })
  expect(directory.snapshot({ scope: '', q: 'Personal notes' })).toMatchObject({ scopePartial: true,
    items: [{ runtime: primary }, { runtime: remote }] })
  expect(read).toHaveBeenCalledTimes(calls)
  const page = await directory.rows(project, { kind: 'conversations', q: 'review' })
  expect(directory.snapshot({ scope: '9', q: 'review', page })).toMatchObject({ scopePartial: false, nextCursor: 'owner-page-two',
    items: [{ runtime: project, sessionId: 'same-id' }] })
  const next = await directory.rows(project, { kind: 'conversations', q: 'review', cursor: page.nextCursor! })
  expect(directory.snapshot({ scope: '9', q: 'review', page: next })).toMatchObject({ nextCursor: null, items: [{ sessionId: 'page-two' }] })
  expect(directory.snapshot({ scope: '', q: 'undiscovered' })).toMatchObject({ scopePartial: true, items: [{ sessionId: 'page-two' }] })
  const pending = directory.rows(project, { kind: 'conversations', q: 'held' })
  const changed = vi.fn()
  const unsubscribe = directory.authority.subscribe(changed)
  await expect(directory.rows(project, { kind: 'conversations', q: 'denied' })).rejects.toThrow('Forbidden')
  expect(changed).toHaveBeenCalledOnce()
  unsubscribe()
  held.resolve(undefined)
  await expect(pending).rejects.toThrow('directory changed')
  expect(directory.target('9')).toBeUndefined()
  expect(directory.snapshot({ scope: '', q: 'undiscovered' })).toMatchObject({ projects: [], items: [] })
  revoked = true
  directory.clear()
  await directory.manifest(7, primary)
  expect(directory.snapshot({ scope: '', q: 'review' })).toMatchObject({ projects: [], items: [] })
})

it('reads only central metadata for twenty granted computers, then only rows on the explicitly expanded computer', async () => {
  vi.stubGlobal('location', new URL('https://harness.invalid'))
  const calls: string[] = []
  const reader = new EntryDirectory(async (path) => {
    calls.push(path)
    if (path === '/account/api/runtimes') return { items: rows, nextCursor: null }
    if (path.startsWith('/account/api/context?')) return { user: { id: 7, displayName: 'A' }, projects: [], environment: { id: rows[0]!.id } }
    if (path.includes(rows[1]!.id)) return { runtimeId: rows[1]!.id, items: [], workspaces: [], nextCursor: 'more' }
    throw new Error('Unselected computer')
  })
  await reader.manifest(7, target(0))
  expect(calls).toHaveLength(2)
  expect(reader.snapshot()).toMatchObject({ personalComplete: false, items: [],
    personalWorkspaces: rows.map(() => ({ items: [], syncedAt: null })) })
  await reader.rows(target(1), { kind: 'conversations', q: 'draft', cursor: '1' })
  expect(calls).toHaveLength(3)
  expect(new URL(calls[2]!, 'https://harness.invalid').searchParams.get('dshRuntime')).toBe(rows[1]!.id)
  reader.clear()
  await expect(reader.rows(target(1), { kind: 'workspaces' })).rejects.toThrow('unavailable')
  expect(calls).toHaveLength(3)
})

it('accepts both personal cursors from one owner and rejects a mismatched companion before either page is retained', async () => {
  vi.stubGlobal('location', new URL('https://harness.invalid'))
  const owner = target(0), other = target(1)
  let foreign = true
  const reader = new EntryDirectory(async (path) => {
    if (path === '/account/api/runtimes') return { items: rows, nextCursor: null }
    if (path.startsWith('/account/api/context?')) return { user: { id: 7, displayName: 'A' }, projects: [], environment: { id: owner.runtimeId } }
    expect(new URL(path, 'https://harness.invalid').searchParams.get('include')).toBe('conversations')
    return { runtimeId: owner.runtimeId, workspaces: [{ workspaceId: 'work', sessionIds: [] }], items: [], nextCursor: 'next-folder',
      conversationPage: { runtimeId: foreign ? other.runtimeId : owner.runtimeId,
        items: [{ sessionId: 'my-conversation', runtime: owner }], workspaces: [], nextCursor: 'next-session' } }
  })
  await reader.manifest(7, owner)
  const load = () => reader.rows(owner, { kind: 'workspaces', includeConversations: true })
  await expect(load()).rejects.toThrow('selected Runtime')
  expect(reader.snapshot()).toMatchObject({ items: [], personalWorkspaces: rows.map(() => ({ items: [], syncedAt: null })) })
  foreign = false
  expect((await load()).combined).toBe(true)
  expect(reader.snapshot()).toMatchObject({ items: [{ sessionId: 'my-conversation' }], personalWorkspaces: expect.arrayContaining([
    expect.objectContaining({ workspacesCursor: 'next-folder', conversationsCursor: 'next-session' })]) as object })
})
