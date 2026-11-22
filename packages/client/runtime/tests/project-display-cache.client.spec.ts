/** Verified project display cache prevents `#id` flashes while preserving live authority checks and isolation. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { EntryDirectory } from '../src/client/entry-directory.ts'
import { clearVerifiedProjectDisplayCache } from '../src/client/project-display-cache.ts'
import type { SessionRuntimeTarget } from '../src/client/contract/sessions.ts'

const nodeA = '20000000-0000-4000-8000-000000000001' as NonNullable<SessionRuntimeTarget['nodeId']>
const nodeB = '20000000-0000-4000-8000-000000000002' as NonNullable<SessionRuntimeTarget['nodeId']>
const personalRuntime = '10000000-0000-4000-8000-000000000001' as NonNullable<SessionRuntimeTarget['runtimeId']>
const projectRuntime = '30000000-0000-4000-8000-000000000009' as NonNullable<SessionRuntimeTarget['runtimeId']>
const projectRuntimeNext = '30000000-0000-4000-8000-000000000010' as NonNullable<SessionRuntimeTarget['runtimeId']>

function makeReader(options: { account?: number; nodeId?: string; runtimeId?: string } = {}) {
  const account = options.account ?? 7
  const nodeId = options.nodeId ?? nodeA
  const runtimeId = options.runtimeId ?? projectRuntime
  return vi.fn(async (path: string) => {
    if (path === '/account/api/runtimes') {
      return {
        items: [
          { id: personalRuntime, owner: { kind: 'personal', id: account, name: 'Me' }, node: { id: nodeA, name: 'Node A', status: 'active' }, observedState: 'ready' },
          { id: runtimeId, owner: { kind: 'project', id: 9, name: 'untrusted' }, node: { id: nodeId, name: 'Node A', status: 'active' }, observedState: 'stopped', metadataOnNode: true },
        ],
        nextCursor: null,
      }
    }
    if (path.startsWith('/account/api/workbench/context?')) {
      return {
        user: { id: account, displayName: 'Me' },
        environment: { id: personalRuntime },
        projects: [{ projectId: 9, nodeId, runtimeId, name: 'untrusted', metadataOnNode: true }],
      }
    }
    throw Object.assign(new Error('Forbidden'), { status: 403 })
  })
}

describe('verified project display cache', () => {
  beforeEach(() => {
    vi.stubGlobal('location', new URL('https://harness.invalid'))
    clearVerifiedProjectDisplayCache()
  })

  afterEach(() => {
    clearVerifiedProjectDisplayCache()
    vi.unstubAllGlobals()
  })

  it('hydrates verified names across directory reloads while keeping projectRef pending for live refresh', async () => {
    const bootstrap: SessionRuntimeTarget = { kind: 'personal', runtimeId: personalRuntime }
    const first = new EntryDirectory(makeReader())
    await first.manifest(7, bootstrap)
    // First cold load falls back to #9 before owner verification.
    expect((first.snapshot() as { projects: Array<{ name: string }> }).projects[0]!.name).toBe('#9')
    const ref = first.projectRef(first.target('9')!)
    expect(ref).toBeDefined()
    first.receiveProject({ projectId: 9, nodeId: nodeA, runtimeId: projectRuntime, name: 'Remote Alpha', rootPath: '/srv/alpha' }, ref!.version)
    expect((first.snapshot() as { projects: Array<{ name: string; path: string }> }).projects[0]).toMatchObject({ name: 'Remote Alpha', path: '/srv/alpha' })

    // Simulated reload / fresh EntryDirectory for same account + node + runtime: no #9 flash!
    const reloaded = new EntryDirectory(makeReader())
    await reloaded.manifest(7, bootstrap)
    expect((reloaded.snapshot() as { projects: Array<{ name: string; path: string }> }).projects[0]).toMatchObject({ name: 'Remote Alpha', path: '/srv/alpha' })
    // Live metadata refresh is still required (ownerDisplayLoaded remains unset).
    expect(reloaded.projectRef(reloaded.target('9')!)).toBeDefined()

    // Different account, node, or runtimeId does NOT reuse cached label.
    const otherAccount = new EntryDirectory(makeReader({ account: 8 }))
    await otherAccount.manifest(8, bootstrap)
    expect((otherAccount.snapshot() as { projects: Array<{ name: string }> }).projects[0]!.name).toBe('#9')

    const migratedNode = new EntryDirectory(makeReader({ nodeId: nodeB }))
    await migratedNode.manifest(7, bootstrap)
    expect((migratedNode.snapshot() as { projects: Array<{ name: string }> }).projects[0]!.name).toBe('#9')

    const newRuntime = new EntryDirectory(makeReader({ runtimeId: projectRuntimeNext }))
    await newRuntime.manifest(7, bootstrap)
    expect((newRuntime.snapshot() as { projects: Array<{ name: string }> }).projects[0]!.name).toBe('#9')
  })

  it('evicts cached project labels on clear(true) and 403 withdrawal', async () => {
    const bootstrap: SessionRuntimeTarget = { kind: 'personal', runtimeId: personalRuntime }
    const directory = new EntryDirectory(makeReader())
    await directory.manifest(7, bootstrap)
    const ref = directory.projectRef(directory.target('9')!)!
    directory.receiveProject({ projectId: 9, nodeId: nodeA, runtimeId: projectRuntime, name: 'Secret Team', rootPath: '/srv/secret' }, ref.version)

    // 403 on rows withdraws the project and evicts its cached display.
    await expect(directory.rows(directory.target('9')!, { kind: 'conversations' })).rejects.toThrow('Forbidden')
    const after403 = new EntryDirectory(makeReader())
    await after403.manifest(7, bootstrap)
    expect((after403.snapshot() as { projects: Array<{ name: string }> }).projects[0]!.name).toBe('#9')

    // clear(true) purges cached labels for the account.
    const ref2 = after403.projectRef(after403.target('9')!)!
    after403.receiveProject({ projectId: 9, nodeId: nodeA, runtimeId: projectRuntime, name: 'Restored', rootPath: '/srv/restored' }, ref2.version)
    after403.clear(true)
    const afterClear = new EntryDirectory(makeReader())
    await afterClear.manifest(7, bootstrap)
    expect((afterClear.snapshot() as { projects: Array<{ name: string }> }).projects[0]!.name).toBe('#9')
  })
})
