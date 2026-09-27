import { setImmediate } from 'node:timers/promises'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import CommandRuntime from '@deepseek-ai/dsh-commands'
import { createScope } from '@deepseek-ai/dsh-scope'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import Approval from '@deepseek-ai/dsh-user-approval'
import { SettingsProvider, type SettingsNamespace } from '@deepseek-ai/dsh-settings'
import PermissionPresets, { AUTO_PRESET } from '../src/index.ts'

const contexts: Context[] = []
afterEach(async () => { for (const ctx of contexts.splice(0)) await ctx.fiber.dispose() })

async function fixture(authorizeSelection?: (agent: Agent, preset: string) => Promise<void>) {
  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(SessionStore)
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(CommandRuntime)
  await ctx.plugin(Approval, {})
  ctx.provide('shell', {
    sandboxMode: 'workspace-write',
    resolve() { throw new Error('permission command fixture has no shell') },
    run() { throw new Error('permission command fixture has no shell') },
    start() { throw new Error('permission command fixture has no shell') },
  })
  if (authorizeSelection !== undefined) ctx.provide('permissionPresetAuthorization', { canSelect: () => true, authorizeSelection })
  const permissionFiber = await ctx.plugin(PermissionPresets, {})
  ctx.permissionPresets.registerAuto(() => {})
  const session = ctx.sessions.create(SessionId('permission-selection'))
  const agent = {
    id: session.id, session,
    inject(message) { session.append('user/message', message, { surfaceOp: 'append' }) },
  } as Agent
  await ctx.plugin(Object.assign((inner: Context) => { createScope(inner, agent) }, { inject: ['commands'] }))
  const select = (signal = new AbortController().signal) => ctx.commands.execute(agent, '/permission auto', [], signal)
  return { ctx, session, agent, select, permissionFiber }
}

describe('permission command authorization', () => {
  it('awaits live authorization before recording an explicit selection', async () => {
    const entered = Promise.withResolvers<undefined>(), release = Promise.withResolvers<undefined>()
    let requested: { agent: Agent; preset: string } | undefined
    const f = await fixture(async (agent, preset) => { requested = { agent, preset }; entered.resolve(undefined); await release.promise })
    const pending = f.select()
    try {
      await entered.promise
      expect(requested).toEqual({ agent: f.agent, preset: AUTO_PRESET })
      expect(f.ctx.permissionPresets.current(f.session)).toBe('workspace-write')
    } finally { release.resolve(undefined) }
    expect(await pending).toMatchObject({ result: { kind: 'success', text: 'preset auto' } })
    expect(f.ctx.permissionPresets.current(f.session)).toBe(AUTO_PRESET)
  })

  it('leaves the existing preset and approval policy unchanged on refusal', async () => {
    const f = await fixture(async () => { throw new Error('Auto eligibility revoked') })
    const before = f.session.snapshotEvents().filter(event => event.type === 'permission/preset' || event.type === 'sandbox/mode' || event.type === 'approval/policy')
    await expect(f.select()).rejects.toThrow('Auto eligibility revoked')
    expect(f.session.snapshotEvents().filter(event => event.type === 'permission/preset' || event.type === 'sandbox/mode' || event.type === 'approval/policy')).toEqual(before)
    expect(f.ctx.permissionPresets.current(f.session)).toBe('workspace-write')
  })

  it('does not apply a late grant after the command has been cancelled', async () => {
    const entered = Promise.withResolvers<undefined>()
    const release = Promise.withResolvers<undefined>(), exited = Promise.withResolvers<undefined>()
    const f = await fixture(async () => { entered.resolve(undefined); await release.promise; exited.resolve(undefined) })
    const controller = new AbortController()
    const pending = f.select(controller.signal)
    const rejected = expect(pending).rejects.toThrow('selection cancelled')
    await entered.promise
    controller.abort(new Error('selection cancelled'))
    await rejected
    release.resolve(undefined)
    await exited.promise
    // Drain the cancelled handler's continuation, which outlives the public command promise.
    await setImmediate()
    expect(f.ctx.permissionPresets.current(f.session)).toBe('workspace-write')
  })

  it('preserves local selection when no deployment authority is composed', async () => {
    const f = await fixture()
    expect(await f.select()).toMatchObject({ result: { kind: 'success' } })
    expect(f.ctx.permissionPresets.current(f.session)).toBe(AUTO_PRESET)
  })

  it('refuses a managed selection while its execution Provider is unavailable', async () => {
    const f = await fixture()
    f.ctx.provide('executionAuthorityRequired', true)
    await expect(f.select()).rejects.toThrow('Managed execution requires its authorization provider')
    expect(f.ctx.permissionPresets.current(f.session)).toBe('workspace-write')
  })

  it('refuses a selection grant from a policy that was removed while it was pending', async () => {
    const f = await fixture()
    const entered = Promise.withResolvers<undefined>(), release = Promise.withResolvers<undefined>()
    const policy = await f.ctx.plugin((ctx: Context) => {
      ctx.provide('permissionPresetAuthorization', { canSelect: () => true,
        authorizeSelection: async () => { entered.resolve(undefined); await release.promise } })
    })
    const pending = f.select()
    const rejected = expect(pending).rejects.toThrow('selection authorization changed before applying')
    await entered.promise
    await policy.dispose()
    release.resolve(undefined)
    await rejected
    expect(f.ctx.permissionPresets.current(f.session)).toBe('workspace-write')
  })
})

class MemorySettings extends SettingsProvider {
  readonly writable = true
  readonly doc: Record<string, unknown> = {}
  protected load(): Promise<Record<string, unknown>> { return Promise.resolve({}) }
  protected async persist(ns: SettingsNamespace, section: Record<string, unknown>): Promise<void> {
    this.doc[ns] = structuredClone(section)
  }
}

describe('permission default authorization', () => {
  it('refuses a default grant from a policy that was removed before persistence', async () => {
    const f = await fixture()
    const entered = Promise.withResolvers<undefined>(), release = Promise.withResolvers<undefined>()
    const policy = await f.ctx.plugin((ctx: Context) => {
      ctx.provide('permissionPresetAuthorization', { canSelect: () => true,
        authorizeDefault: async () => { entered.resolve(undefined); await release.promise } })
    })
    await f.ctx.plugin(MemorySettings)
    const settings = f.ctx.settings as MemorySettings
    const pending = settings.mutate('permission', [{ op: 'set', path: ['defaultPreset'], value: 'danger-full-access' }])
    const rejected = expect(pending).rejects.toThrow('default authorization changed before persistence')
    await entered.promise
    await policy.dispose()
    release.resolve(undefined)
    await rejected
    expect(settings.doc).toEqual({})
  })

  it('requires live authorization before a Full default is persisted but never selects Auto', async () => {
    const f = await fixture()
    let admin = false
    const names: string[] = []
    f.ctx.provide('permissionPresetAuthorization', { canSelect: () => true, authorizeDefault: async (name) => {
      names.push(name)
      if (name === 'danger-full-access' && !admin) throw new Error('fresh admin authorization required')
    } })
    await f.ctx.plugin(MemorySettings)
    const settings = f.ctx.settings as MemorySettings
    expect(names).toEqual([])
    await expect(settings.mutate('permission', [{ op: 'set', path: ['defaultPreset'], value: 'danger-full-access' }]))
      .rejects.toThrow('fresh admin authorization required')
    expect(settings.doc).toEqual({})
    admin = true
    await settings.mutate('permission', [{ op: 'set', path: ['defaultPreset'], value: 'danger-full-access' }])
    expect(settings.doc).toEqual({ permission: { defaultPreset: 'danger-full-access' } })
    expect(f.ctx.permissionPresets.current(f.session)).toBe('workspace-write')
    await expect(settings.mutate('permission', [{ op: 'set', path: ['defaultPreset'], value: AUTO_PRESET }])).rejects.toThrow()
    expect(names).toEqual(['danger-full-access', 'danger-full-access'])
  })

  it('refuses managed default writes without their execution Provider', async () => {
    const f = await fixture()
    f.ctx.provide('executionAuthorityRequired', true)
    await f.ctx.plugin(MemorySettings)
    await expect(f.ctx.settings.mutate('permission', [{ op: 'set', path: ['defaultPreset'], value: 'danger-full-access' }]))
      .rejects.toThrow('Managed execution requires its authorization provider')
    expect((f.ctx.settings as MemorySettings).doc).toEqual({})
  })

  it('does not persist a Full default when its owner is unloaded during authorization', async () => {
    const f = await fixture()
    const entered = Promise.withResolvers<undefined>(), release = Promise.withResolvers<undefined>()
    f.ctx.provide('permissionPresetAuthorization', { canSelect: () => true,
      authorizeDefault: async () => { entered.resolve(undefined); await release.promise } })
    await f.ctx.plugin(MemorySettings)
    const settings = f.ctx.settings as MemorySettings
    const pending = settings.mutate('permission', [{ op: 'set', path: ['defaultPreset'], value: 'danger-full-access' }])
    const rejected = expect(pending).rejects.toThrow('disposed during write authorization')
    await entered.promise
    const disposal = f.permissionFiber.dispose()
    release.resolve(undefined)
    await rejected
    await disposal
    expect(settings.doc).toEqual({})
  })
})
