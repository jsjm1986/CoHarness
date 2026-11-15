import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import SessionStore from '@deepseek-ai/dsh-session'
import type { Session } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ApprovalService, { setApprovalPolicy } from '@deepseek-ai/dsh-user-approval'
import { describe, expect, it, onTestFinished, vi } from 'vitest'

async function harness() {
  const ctx = new Context()
  onTestFinished(() => ctx.fiber.dispose())
  await ctx.plugin(SessionStore)
  const registry = await ctx.plugin(SessionProjectionRegistry)
  return { ctx, registry }
}

function agentFor(session: Session): Agent {
  return { session } as Agent
}

describe('approval state', () => {
  it('keeps only the current policy and turn flag after a long history', async () => {
    const { ctx } = await harness()
    await ctx.plugin(ApprovalService)
    const session = ctx.sessions.create()
    setApprovalPolicy(session, 'ask')
    session.append('turn/start', { turn: 1 })
    for (let turn = 1; turn <= 1_000; turn++) {
      setApprovalPolicy(session, 'never')
      session.append('turn/end', { turn, reason: { kind: 'completed' } })
      session.append('turn/start', { turn: turn + 1 })
      setApprovalPolicy(session, 'ask')
    }
    expect(ctx.sessionProjections.checkpoint(session)['approvalState']?.val).toEqual({ policy: 'ask', turnOpen: true })
    expect(ctx.approval.overrideOf(session)).toBe('ask')
  })

  it('rebuilds policy and turn state for a replacement service without replaying decisions', async () => {
    const { ctx } = await harness()
    const owner = await ctx.plugin(ApprovalService)
    const session = ctx.sessions.create()
    expect(ctx.approval.overrideOf(session)).toBeUndefined()
    await expect(ctx.approval.request({ agent: agentFor(session), toolName: 'echo' })).rejects.toThrow('outside an open turn')

    session.append('turn/start', { turn: 1 })
    session.append('turn/start', { turn: 1 })
    setApprovalPolicy(session, 'never')
    setApprovalPolicy(session, 'never')
    session.append('step/start', { turn: 1, step: 1 })
    const rows = ctx.sessionProjections.checkpoint(session)
    const cut = session.seq
    expect(rows['approvalState']).toEqual({
      ver: 1,
      seq: cut - 1,
      val: { policy: 'never', turnOpen: true },
    })
    expect(ctx.sessionProjections.snapshot(session).values).not.toHaveProperty('approvalState')

    session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
    session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
    setApprovalPolicy(session, 'ask')
    await owner.dispose()
    const answerer = vi.fn(() => Promise.resolve<'allowed-once'>('allowed-once'))
    ctx.on('approval/request', answerer)
    const before = session.seq
    await ctx.plugin(ApprovalService)
    expect(ctx.approval.overrideOf(session)).toBe('ask')
    await expect(ctx.approval.request({ agent: agentFor(session), toolName: 'echo' })).rejects.toThrow('outside an open turn')
    expect(session.seq).toBe(before)
    expect(answerer).not.toHaveBeenCalled()

    session.append('turn/start', { turn: 2 })
    await expect(ctx.approval.request({ agent: agentFor(session), toolName: 'echo' })).resolves.toBe('allowed-once')
    expect(answerer).toHaveBeenCalledOnce()
    expect(session.snapshotEvents().slice(-2).map(event => event.type)).toEqual(['approval/asked', 'approval/decided'])
    expect(ctx.sessionProjections.checkpoint(session)['approvalState']?.val).toEqual({ policy: 'ask', turnOpen: true })
  })

  it('serves current reads from the projection and releases the unit with the service', async () => {
    const { ctx } = await harness()
    const service = await ctx.plugin(ApprovalService)
    const session = ctx.sessions.create()
    setApprovalPolicy(session, 'never')
    expect(ctx.approval.overrideOf(session)).toBe('never')
    const read = vi.spyOn(session, 'eventAt')
    const snapshot = vi.spyOn(session, 'snapshotEvents')
    expect(ctx.approval.overrideOf(session)).toBe('never')
    expect(ctx.approval.overrideOf(session)).toBe('never')
    expect(read).not.toHaveBeenCalled()
    expect(snapshot).not.toHaveBeenCalled()
    const row = ctx.sessionProjections.checkpoint(session)['approvalState']

    await service.dispose()
    session.append('turn/start', { turn: 1 })
    session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
    // The released unit keeps its last row and folds no event after the unload.
    expect(ctx.sessionProjections.checkpoint(session)).toHaveProperty('approvalState', row)
    expect(ctx.sessionProjections.checkpoint(ctx.sessions.create())).not.toHaveProperty('approvalState')
    await ctx.plugin(ApprovalService)
    expect(ctx.approval.overrideOf(session)).toBe('never')
    expect(ctx.sessionProjections.checkpoint(session)['approvalState']?.val).toEqual({ policy: 'never', turnOpen: false })
  })

  it('provides the same policy when the optional prompt service loads or restarts later', async () => {
    const { ctx } = await harness()
    await ctx.plugin(ApprovalService)
    const session = ctx.sessions.create()
    setApprovalPolicy(session, 'never')
    const promptOwner = await ctx.plugin(SystemPrompt)
    const context = { agent: agentFor(session) }
    const first = (await ctx.systemPrompt.assemble(context)).contexts.filter(entry => entry.name === 'approval:policy')
    expect(first).toHaveLength(1)
    expect(first[0]?.text).toContain('Approval prompts are disabled')
    await promptOwner.dispose()
    await ctx.plugin(SystemPrompt)
    const replacement = (await ctx.systemPrompt.assemble(context)).contexts.filter(entry => entry.name === 'approval:policy')
    expect(replacement).toEqual(first)
  })

  it('keeps serving from the log fold while the optional registry is unavailable', async () => {
    const { ctx, registry } = await harness()
    await ctx.plugin(ApprovalService)
    const session = ctx.sessions.create()
    setApprovalPolicy(session, 'never')
    expect(ctx.approval.overrideOf(session)).toBe('never')

    // The registry is an optional composition: its unload releases the unit
    // and reads fall back to the direct log fold without losing the service.
    await registry.dispose()
    expect(ctx.get('sessionProjections')).toBeUndefined()
    expect(ctx.approval.overrideOf(session)).toBe('never')
    session.append('turn/start', { turn: 1 })
    await expect(ctx.approval.request({ agent: agentFor(session), toolName: 'echo' })).resolves.toBe('rejected')

    await ctx.plugin(SessionProjectionRegistry)
    const next = ctx.sessions.create()
    setApprovalPolicy(next, 'ask')
    expect(ctx.approval.overrideOf(next)).toBe('ask')
    expect(ctx.sessionProjections.checkpoint(next)['approvalState']?.val).toEqual({ policy: 'ask', turnOpen: false })
  })
})
