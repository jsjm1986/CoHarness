// @vitest-environment jsdom
/** Tool paths and details read only their Session's Host description. */
import { expect, it, vi } from 'vitest'
import { SlotTestRuntime } from '@deepseek-ai/dsh-client-test-runtime'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-runtime/client'
import type { SessionId, SessionRuntimeTarget } from '@deepseek-ai/dsh-client-runtime/client'
import type { HostDescription } from '@deepseek-ai/dsh-client-connection/client'
import { apply, inject } from '../src/client/apply.ts'

it('captures the target Host home for both tool renderers without opening a connection', async () => {
  const runtime = await SlotTestRuntime.create()
  const target: SessionRuntimeTarget = { kind: 'personal', runtimeId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' as never }
  const first = createSnapshotStore<HostDescription | undefined>({ version: 'test', cwd: '/work/a', attachedSessions: 0,
    home: '/Users/local', canOpenPath: true })
  const second = createSnapshotStore<HostDescription | undefined>({ version: 'test', cwd: '/work/b', attachedSessions: 0,
    home: '/home/ubuntu', canOpenPath: false })
  const start = vi.fn(), forTarget = vi.fn(() => ({ hostDescription: second, start }))
  runtime.provide('connection', { hostDescription: first, forTarget, start })
  Object.assign(runtime.sessions, { runtimeTargetFor: (id: SessionId) => id === 'remote' ? target : undefined })
  try {
    await runtime.declare({
      'conversation.chat.node': { kind: 'keyed', scope: 'session' },
      'conversation.details.tool': { kind: 'single', scope: 'session' },
    } as never)
    await runtime.mount({ inject, apply })
    for (const slot of ['conversation.chat.node', 'conversation.details.tool'] as const) {
      const face = runtime.slots.entries(slot)[0]!.inject as (id: SessionId) => { hooks: { hostDescription: typeof first } }
      expect(face('remote' as SessionId).hooks.hostDescription).toBe(second)
      expect(face('local' as SessionId).hooks.hostDescription).toBe(first)
      expect(face('remote' as SessionId).hooks.hostDescription.getSnapshot()?.home).toBe('/home/ubuntu')
    }
    expect(forTarget).toHaveBeenCalledWith(target)
    expect(start).not.toHaveBeenCalled()
  } finally { await runtime.dispose() }
})
