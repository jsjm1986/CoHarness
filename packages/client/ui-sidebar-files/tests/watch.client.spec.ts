/** Directory notifications and disposal through the workspace-resources change feed. */
import { describe, expect, it, onTestFinished, vi } from 'vitest'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { WorkspaceResourceTarget } from '@deepseek-ai/dsh-client-runtime/client'
import { createWatch } from '../src/client/face.ts'

const SESSION = 'directory-watch-session' as SessionId
const ROOT = '/work/app'
const TARGET = { kind: 'base' } as WorkspaceResourceTarget

interface Harness {
  readonly listeners: Set<(change: { sessionId: SessionId; path: string; version?: string }) => void>
  readonly observeChanges: ReturnType<typeof vi.fn>
  readonly controller: AbortController
  readonly iterator: AsyncIterator<'ready' | 'change'>
  readonly push: (path: string, sessionId?: SessionId) => void
}

/** A registry fake: every pushed frame lands on each subscribed listener. */
function mount(options: { directory?: string | undefined; target?: WorkspaceResourceTarget | undefined } = {}): Harness {
  const directory = 'directory' in options ? options.directory : 'src'
  const target = 'target' in options ? options.target : TARGET
  const listeners = new Set<(change: { sessionId: SessionId; path: string; version?: string }) => void>()
  type Change = { sessionId: SessionId; path: string; version?: string }
  const observeChanges = vi.fn((_target: WorkspaceResourceTarget, listener: (change: Change) => void) => {
    listeners.add(listener)
    return () => { listeners.delete(listener) }
  })
  const controller = new AbortController()
  const iterator = createWatch({ observeChanges }, () => target, () => directory)(SESSION, ROOT, controller.signal)[Symbol.asyncIterator]()
  const h: Harness = {
    listeners, observeChanges, controller, iterator,
    push: (path, sessionId = SESSION) => { for (const listener of [...listeners]) listener({ sessionId, path }) },
  }
  onTestFinished(async () => {
    controller.abort()
    await iterator.return?.()
  })
  return h
}

describe('createWatch', () => {
  it('arms ready immediately and forwards changes under the directory', async () => {
    const h = mount()
    await expect(h.iterator.next()).resolves.toEqual({ done: false, value: 'ready' })
    expect(h.observeChanges).toHaveBeenCalledWith(TARGET, expect.any(Function))
    const next = h.iterator.next()
    h.push('src/a.ts')
    await expect(next).resolves.toEqual({ done: false, value: 'change' })
  })

  it('ignores frames from other Sessions and outside the directory', async () => {
    const h = mount()
    await h.iterator.next()
    h.push('src/a.ts', 'other-session' as SessionId)
    h.push('guides/b.md')
    h.push('srcfile')
    expect(h.listeners.size).toBe(1)
    const next = h.iterator.next()
    h.push('src/deep/c.ts')
    await expect(next).resolves.toEqual({ done: false, value: 'change' })
  })

  it('treats the workspace root as matching every change', async () => {
    const h = mount({ directory: '' })
    await h.iterator.next()
    const next = h.iterator.next()
    h.push('anywhere/file.ts')
    await expect(next).resolves.toEqual({ done: false, value: 'change' })
  })

  it('unsubscribes and ends when the node aborts', async () => {
    const h = mount()
    await h.iterator.next()
    expect(h.listeners.size).toBe(1)
    h.controller.abort()
    await expect(h.iterator.next()).resolves.toEqual({ done: true, value: undefined })
    expect(h.listeners.size).toBe(0)
  })

  it('does not subscribe for an already-cancelled node', async () => {
    const h = mount()
    h.controller.abort()
    await expect(h.iterator.next()).resolves.toEqual({ done: true, value: undefined })
    expect(h.observeChanges).not.toHaveBeenCalled()
  })

  it('ends without subscribing when the runtime target or the workspace root is unavailable', async () => {
    const noTarget = mount({ target: undefined })
    await expect(noTarget.iterator.next()).resolves.toEqual({ done: true, value: undefined })
    expect(noTarget.observeChanges).not.toHaveBeenCalled()
    const noRoot = mount({ directory: undefined })
    await expect(noRoot.iterator.next()).resolves.toEqual({ done: true, value: undefined })
    expect(noRoot.observeChanges).not.toHaveBeenCalled()
  })
})
