/** Command-catalog invalidation while a remote pull is still in flight. */
import { describe, expect, it } from 'vitest'
import type { SessionId } from '@deepseek-ai/dsh-client-runtime/client'
import { CommandDirectory, type CommandDescriptor } from '../src/client/directory.ts'

const firstSession = 'first' as SessionId
const secondSession = 'second' as SessionId
const stale: readonly CommandDescriptor[] = [{ name: 'stale', description: 'old catalog' }]
const fresh: readonly CommandDescriptor[] = [{ name: 'fresh', description: 'current catalog' }]

function pendingCatalog() {
  const pulls: Array<ReturnType<typeof Promise.withResolvers<readonly CommandDescriptor[]>>> = []
  let active = 0
  let peak = 0
  const directory = new CommandDirectory(async () => {
    const pull = Promise.withResolvers<readonly CommandDescriptor[]>()
    pulls.push(pull)
    peak = Math.max(peak, ++active)
    try { return await pull.promise } finally { active-- }
  })
  return { directory, pulls, peak: () => peak }
}

describe('command catalog request ownership', () => {
  it('coalesces a burst of registry and reconnect invalidations into one following pull', async () => {
    const { directory, pulls, peak } = pendingCatalog()
    const completed = directory.refresh(firstSession)
    const waiting = directory.ensureReady(firstSession, new AbortController().signal)
    for (let i = 0; i < 40; i++) {
      directory.invalidateAll()
      directory.resetConnected()
    }
    expect(pulls).toHaveLength(1)
    pulls[0]!.resolve(stale)
    await expect.poll(() => pulls.length).toBe(2)
    expect(directory.resolve(firstSession, 'stale')).toBeUndefined()
    pulls[1]!.resolve(fresh)
    await completed
    await expect(waiting).resolves.toEqual(fresh)
    expect(pulls).toHaveLength(2)
    expect(peak()).toBe(1)
  })

  it('keeps a served catalog during a soft refresh and discards a superseded failure', async () => {
    const { directory, pulls } = pendingCatalog()
    const initial = directory.refresh(firstSession)
    pulls[0]!.resolve(stale)
    await initial
    const refreshing = directory.refresh(firstSession)
    directory.invalidateAll()
    expect(directory.resolve(firstSession, 'stale')).toBeDefined()
    expect(pulls).toHaveLength(2)
    pulls[1]!.reject(new Error('superseded connection'))
    await expect.poll(() => pulls.length).toBe(3)
    expect(directory.resolve(firstSession, 'stale')).toBeDefined()
    pulls[2]!.resolve(fresh)
    await refreshing
    expect(directory.resolve(firstSession, 'fresh')).toBeDefined()
    expect(directory.resolve(firstSession, 'stale')).toBeUndefined()
  })

  it('does not cancel another waiter or another browser directory when one submit aborts', async () => {
    const left = pendingCatalog()
    const right = pendingCatalog()
    const controller = new AbortController()
    const withdrawn = left.directory.ensureReady(firstSession, controller.signal)
    const retained = left.directory.ensureReady(firstSession, new AbortController().signal)
    const independent = right.directory.ensureReady(firstSession, new AbortController().signal)
    controller.abort(new Error('composer switched'))
    await expect(withdrawn).rejects.toThrow('composer switched')
    expect(left.pulls).toHaveLength(1)
    expect(right.pulls).toHaveLength(1)
    left.pulls[0]!.resolve(fresh)
    right.pulls[0]!.resolve(stale)
    await expect(retained).resolves.toEqual(fresh)
    await expect(independent).resolves.toEqual(stale)
  })

  it('allows another session to finish while one session waits for its replacement', async () => {
    const calls = new Map<SessionId, Array<ReturnType<typeof Promise.withResolvers<readonly CommandDescriptor[]>>>>()
    const directory = new CommandDirectory((id) => {
      const pull = Promise.withResolvers<readonly CommandDescriptor[]>()
      const entries = calls.get(id) ?? []
      entries.push(pull)
      calls.set(id, entries)
      return pull.promise
    })
    const first = directory.refresh(firstSession)
    directory.resetSession(firstSession)
    const second = directory.refresh(secondSession)
    expect(calls.get(firstSession)).toHaveLength(1)
    calls.get(secondSession)![0]!.resolve(fresh)
    await second
    expect(directory.status(secondSession)).toBe('ready')
    calls.get(firstSession)![0]!.resolve(stale)
    await expect.poll(() => calls.get(firstSession)?.length).toBe(2)
    calls.get(firstSession)![1]!.resolve(fresh)
    await first
  })

  it('reserves the pending pull before a fetch synchronously changes the catalog', async () => {
    let calls = 0
    let active = 0
    let peak = 0
    const directory = new CommandDirectory(async (id) => {
      peak = Math.max(peak, ++active)
      const revision = ++calls
      try {
        if (revision === 1) directory.resetSession(id)
        return revision === 1 ? stale : fresh
      } finally { active-- }
    })
    await directory.refresh(firstSession)
    expect(calls).toBe(2)
    expect(peak).toBe(1)
    expect(directory.resolve(firstSession, 'stale')).toBeUndefined()
    expect(directory.resolve(firstSession, 'fresh')).toBeDefined()
  })
})
