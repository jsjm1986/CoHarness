/** Member-facing Remote surface: scope catalog, list/read, and participant-gated writes. */
import { describe, expect, it, vi } from 'vitest'
import { CollaborationError } from '@deepseek-ai/dsh-collaboration'
import type { CollaborationParticipant } from '@deepseek-ai/dsh-collaboration'
import type { Context } from '@deepseek-ai/cordis'
import type { SettingsSectionHooks } from '@deepseek-ai/dsh-settings'
import { agentFor, memoryHarness } from './harness.ts'
import MemoryService, { type Config } from '../src/index.ts'
import type { MemoryScope, MemorySettings } from '../src/index.ts'

const projectScope: MemoryScope = { kind: 'project' }
const personalScope: MemoryScope = { kind: 'personal' }
const workspaceScope: MemoryScope = { kind: 'workspace', directory: '/tmp/work' }

const input = { key: 'k', kind: 'guidance' as const, summary: 's', content: 'c' }

/** A collaboration service fake: capture yields the bound participant or throws. */
function fakeCollaboration(participant: CollaborationParticipant | undefined) {
  return {
    capture: () => {
      if (participant === undefined) throw new CollaborationError('forbidden')
      return { participant }
    },
  }
}

const rwMember: CollaborationParticipant = {
  userId: 7, username: 'rw', displayName: 'RW', role: 'user',
  scope: { kind: 'project', projectId: 1, projectName: 'p', mode: 'rw' },
}

const roMember: CollaborationParticipant = {
  userId: 8, username: 'ro', displayName: 'RO', role: 'user',
  scope: { kind: 'project', projectId: 1, projectName: 'p', mode: 'ro' },
}

const personalMember: CollaborationParticipant = {
  userId: 9, username: 'me', displayName: 'Me', role: 'user',
  scope: { kind: 'personal' },
}

describe('memberScopes', () => {
  it('lists personal plus non-empty workspace scopes in a personal runtime', async () => {
    const test = await memoryHarness()
    const agent = agentFor(test.ctx, 'ms', { cwd: '/tmp/work' })
    await test.service.save({ ...input, scope: personalScope, key: 'own' }, { kind: 'agent', agent })
    await test.service.save({ ...input, scope: workspaceScope, key: 'w' }, { kind: 'agent', agent })
    const catalog = await test.service.memberScopes()
    expect(catalog.enabled).toBe(true)
    expect(catalog.scopes.map(view => view.scope.kind)).toEqual(['personal', 'workspace'])
    expect(catalog.scopes.every(view => view.writable)).toBe(true)
    expect(catalog.scopes.find(view => view.scope.kind === 'workspace')?.entries).toBe(1)
  })

  it('lists only the project scope in a project runtime', async () => {
    const test = await memoryHarness({ config: { space: 'project' } })
    const catalog = await test.service.memberScopes()
    expect(catalog.scopes.map(view => view.scope.kind)).toEqual(['project'])
  })

  it('reports writable=false for a read-only project member', async () => {
    const test = await memoryHarness({
      config: { space: 'project' },
      beforeService: (ctx) => { ctx.provide('collaboration', fakeCollaboration(roMember)) },
    })
    const catalog = await test.service.memberScopes()
    expect(catalog.scopes[0]?.writable).toBe(false)
  })
})

describe('member reads', () => {
  it('serves entries to any member, including read-only', async () => {
    const test = await memoryHarness({
      config: { space: 'project' },
      beforeService: (ctx) => { ctx.provide('collaboration', fakeCollaboration(roMember)) },
    })
    const agent = agentFor(test.ctx, 'mr', {})
    test.ctx.provide('executionAuthority', { authorize: async () => ({ primaryActorUserId: 1 }) })
    await test.service.save({ ...input, scope: projectScope, key: 'shared' }, { kind: 'agent', agent })
    expect((await test.service.memberList({ scope: projectScope })).map(e => e.key)).toEqual(['shared'])
    expect((await test.service.memberRead({ scope: projectScope, key: 'shared' }))?.content).toBe('c')
  })

  it('returns nothing for a scope the space does not offer', async () => {
    const test = await memoryHarness()
    expect(await test.service.memberList({ scope: projectScope })).toEqual([])
    expect(await test.service.memberRead({ scope: projectScope, key: 'x' })).toBeUndefined()
  })
})

describe('member writes', () => {
  it('lets an rw project member write the project scope with member attribution', async () => {
    const test = await memoryHarness({
      config: { space: 'project' },
      beforeService: (ctx) => { ctx.provide('collaboration', fakeCollaboration(rwMember)) },
    })
    const result = await test.service.memberSave({ ...input, scope: projectScope })
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.entry.updated.source).toBe('member')
      expect(result.entry.updated.userId).toBe(7)
      expect(result.entry.updated.sessionId).toBeUndefined()
    }
  })

  it('rejects an ro project member through collaboration-forbidden', async () => {
    const test = await memoryHarness({
      config: { space: 'project' },
      beforeService: (ctx) => { ctx.provide('collaboration', fakeCollaboration(roMember)) },
    })
    await expect(test.service.memberSave({ ...input, scope: projectScope }))
      .rejects.toMatchObject({ code: 'collaboration-forbidden' })
    await expect(test.service.memberDelete({ scope: projectScope, key: 'k' }))
      .rejects.toMatchObject({ code: 'collaboration-forbidden' })
    expect(await test.service.memberRead({ scope: projectScope, key: 'k' })).toBeUndefined()
  })

  it('rejects a member call without a request principal', async () => {
    const test = await memoryHarness({
      config: { space: 'project' },
      beforeService: (ctx) => { ctx.provide('collaboration', fakeCollaboration(undefined)) },
    })
    await expect(test.service.memberSave({ ...input, scope: projectScope }))
      .rejects.toMatchObject({ code: 'collaboration-forbidden' })
  })

  it('keeps owner semantics when the runtime has no collaboration provider', async () => {
    const test = await memoryHarness()
    const result = await test.service.memberSave({ ...input, scope: personalScope })
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.entry.updated.source).toBe('member')
  })

  it('lets a personal participant write personal and workspace scopes', async () => {
    const test = await memoryHarness({
      beforeService: (ctx) => { ctx.provide('collaboration', fakeCollaboration(personalMember)) },
    })
    expect((await test.service.memberSave({ ...input, scope: personalScope })).ok).toBe(true)
    expect((await test.service.memberSave({ ...input, scope: workspaceScope, key: 'w' })).ok).toBe(true)
    expect((await test.service.memberScopes()).scopes.every(view => view.writable)).toBe(true)
  })

  it('rejects a project participant writing personal scopes', async () => {
    const test = await memoryHarness({
      beforeService: (ctx) => { ctx.provide('collaboration', fakeCollaboration(rwMember)) },
    })
    await expect(test.service.memberSave({ ...input, scope: personalScope }))
      .rejects.toMatchObject({ code: 'collaboration-forbidden' })
    expect((await test.service.memberScopes()).scopes[0]?.writable).toBe(false)
  })

  it('serializes member writes with agent writes on the same key', async () => {
    const test = await memoryHarness({
      config: { space: 'project' },
      beforeService: (ctx) => { ctx.provide('collaboration', fakeCollaboration(rwMember)) },
    })
    test.ctx.provide('executionAuthority', { authorize: async () => ({ primaryActorUserId: 1 }) })
    const agent = agentFor(test.ctx, 'mw', {})
    const [a, b] = await Promise.all([
      test.service.memberSave({ ...input, scope: projectScope, key: 'race' }),
      test.service.save({ ...input, scope: projectScope, key: 'race' }, { kind: 'agent', agent }),
    ])
    expect([a, b].filter(r => r.ok)).toHaveLength(1)
    expect([a, b].filter(r => !r.ok && r.code === 'memory_exists')).toHaveLength(1)
  })
})

/** A settings-service fake that exposes the installed section's hooks. */
function fakeSettings(captured: { hooks?: SettingsSectionHooks<MemorySettings> }) {
  return {
    installSection: (_owner: Context, _ns: string, _schema: unknown, entry: MemorySettings,
      hooks: SettingsSectionHooks<MemorySettings>) => {
      hooks.setSource(() => entry)
      hooks.onChange()
      captured.hooks = hooks
    },
  }
}

describe('scope catalog edges', () => {
  it('counts every entry inside a repeated workspace scope', async () => {
    const test = await memoryHarness()
    const agent = agentFor(test.ctx, 'mw', { cwd: '/tmp/work' })
    await test.service.save({ ...input, scope: workspaceScope, key: 'a' }, { kind: 'agent', agent })
    await test.service.save({ ...input, scope: workspaceScope, key: 'b' }, { kind: 'agent', agent })
    const catalog = await test.service.memberScopes()
    expect(catalog.scopes.find(view => view.scope.kind === 'workspace')?.entries).toBe(2)
  })

  it('offers nothing and reports unwritable while the memory section is disabled', async () => {
    const captured: { hooks?: SettingsSectionHooks<MemorySettings> } = {}
    const test = await memoryHarness({
      beforeService: (ctx) => { ctx.provide('settings', fakeSettings(captured)) },
    })
    const hooks = captured.hooks
    if (hooks === undefined) throw new Error('settings section was not installed')
    hooks.setSource(() => ({ enabled: false }))
    hooks.onChange()
    const agent = agentFor(test.ctx, 'off', { cwd: '/tmp/work' })
    expect(test.service.scopesFor(agent)).toEqual([])
    const catalog = await test.service.memberScopes()
    expect(catalog.enabled).toBe(false)
    expect(catalog.scopes.every(view => !view.writable)).toBe(true)
  })

  it('reports writable=false when the caller cannot be captured', async () => {
    const test = await memoryHarness({
      config: { space: 'project' },
      beforeService: (ctx) => { ctx.provide('collaboration', fakeCollaboration(undefined)) },
    })
    expect((await test.service.memberScopes()).scopes[0]?.writable).toBe(false)
  })
})

describe('catalog ordering and foreign scopes', () => {
  it('orders rows by kind, recency, then key, and skips records outside the scope', async () => {
    vi.useFakeTimers()
    try {
      const test = await memoryHarness()
      const agent = agentFor(test.ctx, 'sort', { cwd: '/tmp/work' })
      vi.setSystemTime(new Date('2026-10-17T00:00:01.000Z'))
      await test.service.save({ ...input, scope: personalScope, key: 'b' }, { kind: 'agent', agent })
      await test.service.save({ ...input, scope: personalScope, key: 'a' }, { kind: 'agent', agent })
      vi.setSystemTime(new Date('2026-10-17T00:00:02.000Z'))
      await test.service.save({ ...input, scope: personalScope, key: 'c' }, { kind: 'agent', agent })
      await test.service.save({ ...input, scope: personalScope, key: 'd', kind: 'background' }, { kind: 'agent', agent })
      await test.service.save({ ...input, scope: workspaceScope, key: 'w' }, { kind: 'agent', agent })
      expect((await test.service.list(personalScope)).map(entry => entry.key)).toEqual(['c', 'a', 'b', 'd'])
    } finally {
      vi.useRealTimers()
    }
  })

  it('skips records whose scope belongs to another space', async () => {
    const test = await memoryHarness({ config: { space: 'project' } })
    test.ctx.provide('executionAuthority', { authorize: async () => ({ primaryActorUserId: 1 }) })
    const agent = agentFor(test.ctx, 'pj', {})
    await test.service.save({ ...input, scope: projectScope, key: 'p' }, { kind: 'agent', agent })
    await test.fiber.dispose()
    const fiber = await test.ctx.plugin(MemoryService, { space: 'personal' } as Config)
    try {
      expect((await test.ctx.memory.memberScopes()).scopes.map(view => view.scope.kind)).toEqual(['personal'])
    } finally {
      await fiber.dispose()
    }
  })
})
