import { Context } from '@deepseek-ai/cordis'
import SessionStore from '@deepseek-ai/dsh-session'
import UserQuestionService from '@deepseek-ai/dsh-user-questions'
import { describe, expect, it, vi } from 'vitest'
import { createApiProxy } from '../src/api-proxy.ts'
import { RpcId } from '../src/api/rpc.ts'

describe('native opening deployment policy', () => {
  it.each(['disabled', 'managed'] as const)('does not execute an opener in a %s deployment', async (policy) => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    await ctx.plugin(UserQuestionService)
    if (policy === 'managed') ctx.provide('collaboration', {
      capture: () => ({ participant: { scope: { kind: 'personal' } } }),
    } as never)
    const open = vi.fn(async () => {})
    const api = createApiProxy(ctx, { cwd: '/work', defaultModelSelection: () => ({ provider: 'p', model: 'm' }), canOpenPath: () => policy === 'managed', openPath: open })
    try {
      const response = await api.host.openPath({ rpcId: RpcId('native-policy'), payload: { path: '/work/file.txt' } }, new AbortController().signal)
      expect(response.result.ok).toBe(false)
      expect(open).not.toHaveBeenCalled()
    } finally { await ctx.fiber.dispose() }
  })

  it('keeps explicit desktop opening available', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    await ctx.plugin(UserQuestionService)
    const open = vi.fn(async () => {})
    const api = createApiProxy(ctx, { cwd: '/work', defaultModelSelection: () => ({ provider: 'p', model: 'm' }), canOpenPath: () => true, openPath: open })
    try {
      const response = await api.host.openPath({ rpcId: RpcId('native-desktop'), payload: { path: '/work/file.txt' } }, new AbortController().signal)
      expect(response.result).toEqual({ ok: true, value: { opened: true } })
      expect(open).toHaveBeenCalledOnce()
    } finally { await ctx.fiber.dispose() }
  })
})
