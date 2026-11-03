// @vitest-environment jsdom
/** Private browser records use verified account, runtime, and Session ownership. */
import { afterEach, describe, expect, it } from 'vitest'
import { clientSessionKey } from '@deepseek-ai/dsh-client-connection/client'
import { sessionPersistenceKey, type SessionId } from '@deepseek-ai/dsh-client-runtime/client'
import { SlotTestRuntime } from '@deepseek-ai/dsh-client-test-runtime'

const runtimes: SlotTestRuntime[] = []
afterEach(async () => { for (const runtime of runtimes.splice(0)) await runtime.dispose() })

async function catalog(id: SessionId) {
  const runtime = await SlotTestRuntime.create()
  runtimes.push(runtime)
  await runtime.sessions.add({ id })
  return { list: runtime.sessions.list }
}

describe('private Session presentation ownership', () => {
  const raw = 'shared-session' as SessionId

  it('keeps standalone records local and preserves the complete raw Session id', async () => {
    const encoded = clientSessionKey({ kind: 'project', projectId: 9 }, raw)
    const sessions = await catalog(encoded)
    expect(sessionPersistenceKey(sessions, encoded, false, 7)).toBe(JSON.stringify(['local', ['personal'], encoded]))
    expect(sessionPersistenceKey(sessions, encoded, false, undefined, 'forget'))
      .toBe(JSON.stringify(['local', ['personal'], encoded]))
  })

  it('requires a visible Session and confirmed account while Host metadata renews', async () => {
    const sessions = await catalog(raw)
    expect(sessionPersistenceKey(sessions, raw, undefined, 7)).toBe(JSON.stringify(['account:7', ['personal'], raw]))
    expect(sessionPersistenceKey(sessions, raw, undefined, undefined)).toBeUndefined()
    expect(sessionPersistenceKey(sessions, raw, true, undefined)).toBeUndefined()
    expect(sessionPersistenceKey(sessions, raw, true, 7)).toBe(JSON.stringify(['account:7', ['personal'], raw]))
    sessions.list.update((state) => { state.byId = {} })
    expect(sessionPersistenceKey(sessions, raw, true, 7)).toBeUndefined()
    expect(sessionPersistenceKey(sessions, raw, true, undefined, 'forget')).toBeUndefined()
    expect(sessionPersistenceKey(sessions, raw, true, 7, 'forget')).toBe(JSON.stringify(['account:7', ['personal'], raw]))
  })

  it('separates accounts and runtime targets even when the underlying Session id is identical', async () => {
    const id = clientSessionKey({ kind: 'project', projectId: 9 }, raw)
    const sessions = { ...await catalog(id), runtimeIdentityFor: () => ({ kind: 'project' as const, projectId: 9 }) }
    expect(sessionPersistenceKey(sessions, id, true, 7)).toBe(JSON.stringify(['account:7', ['project', 9], raw]))
    expect(sessionPersistenceKey(sessions, id, true, 8)).toBe(JSON.stringify(['account:8', ['project', 9], raw]))
    expect(sessionPersistenceKey({ ...sessions, runtimeIdentityFor: () => ({ kind: 'personal' }) }, id, true, 7))
      .toBe(JSON.stringify(['account:7', ['personal'], raw]))
  })

  it('does not infer read ownership from a self-contained Session address', async () => {
    const id = clientSessionKey({ kind: 'project', projectId: 9 }, raw)
    const sessions = { ...await catalog(id), runtimeIdentityFor: () => undefined }
    expect(sessionPersistenceKey(sessions, id, true, 7)).toBeUndefined()
    sessions.list.update((state) => { state.byId = {} })
    expect(sessionPersistenceKey(sessions, id, true, 7)).toBeUndefined()
    expect(sessionPersistenceKey(sessions, id, true, 7, 'forget')).toBe(JSON.stringify(['account:7', ['project', 9], raw]))
  })

  it('erases only addressable retired records under the current verified account', async () => {
    const sessions = { ...await catalog(raw), runtimeIdentityFor: () => undefined }
    expect(sessionPersistenceKey(sessions, raw, true, 7, 'forget')).toBeUndefined()
    const known = { ...sessions, runtimeIdentityFor: () => ({ kind: 'project' as const, projectId: 12 }) }
    expect(sessionPersistenceKey(known, raw, true, 7)).toBe(JSON.stringify(['account:7', ['project', 12], raw]))
    sessions.list.update((state) => { state.byId = {} })
    expect(sessionPersistenceKey(known, raw, true, 7, 'forget')).toBe(JSON.stringify(['account:7', ['project', 12], raw]))
  })
})
