import { Context } from '@deepseek-ai/cordis'
import SessionStore from '@deepseek-ai/dsh-session'
import UserQuestionService from '@deepseek-ai/dsh-user-questions'
import { describe, expect, it, vi } from 'vitest'
import { createApiProxy } from '../src/api-proxy.ts'
import { nativeFileManager } from '../src/native-path-opener.ts'
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

  it('routes reveal and explicit-application gestures to their own openers', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    await ctx.plugin(UserQuestionService)
    const open = vi.fn(async () => {})
    const reveal = vi.fn(async () => {})
    const openApplication = vi.fn(async () => {})
    const api = createApiProxy(ctx, {
      cwd: '/work', defaultModelSelection: () => ({ provider: 'p', model: 'm' }), canOpenPath: () => true,
      openPath: open, revealPath: reveal, openFileApplication: openApplication,
    })
    try {
      const revealed = await api.host.openPath({ rpcId: RpcId('native-reveal'), payload: { path: '/work/file.txt', action: 'reveal' } }, new AbortController().signal)
      expect(revealed.result).toEqual({ ok: true, value: { opened: true } })
      expect(reveal).toHaveBeenCalledOnce()
      expect(open).not.toHaveBeenCalled()
      const chosen = await api.host.openPath({ rpcId: RpcId('native-app'), payload: { path: '/work/file.txt', application: 'com.editor.zed' } }, new AbortController().signal)
      expect(chosen.result).toEqual({ ok: true, value: { opened: true } })
      expect(openApplication).toHaveBeenCalledWith('/work/file.txt', 'com.editor.zed', expect.any(AbortSignal))
      expect(open).not.toHaveBeenCalled()
      openApplication.mockRejectedValueOnce(new Error('application no longer handles this file'))
      const stale = await api.host.openPath({ rpcId: RpcId('native-stale'), payload: { path: '/work/file.txt', application: 'com.editor.gone' } }, new AbortController().signal)
      expect(stale.result.ok).toBe(false)
    } finally { await ctx.fiber.dispose() }
  })

  it('serves file associations through the host face and reports the file manager on describe', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    await ctx.plugin(UserQuestionService)
    const applications = vi.fn(async () => [{ id: 'com.editor.zed', name: 'Zed', default: true, icon: null }])
    ctx.provide('agents', { list: () => [] } as never)
    const api = createApiProxy(ctx, {
      cwd: '/work', defaultModelSelection: () => ({ provider: 'p', model: 'm' }), canOpenPath: () => true,
      fileApplications: applications,
    })
    try {
      const described = await api.host.describe({ rpcId: RpcId('native-describe'), payload: {} })
      expect(described.result).toMatchObject({ ok: true, value: { canOpenPath: true, fileManager: nativeFileManager() } })
      const served = await api.host.fileApplications({ rpcId: RpcId('native-apps'), payload: { path: '/work/file.txt' } }, new AbortController().signal)
      expect(served.result).toEqual({ ok: true, value: { applications: [{ id: 'com.editor.zed', name: 'Zed', default: true, icon: null }] } })
      expect(applications).toHaveBeenCalledWith('/work/file.txt', expect.any(AbortSignal))
      applications.mockRejectedValueOnce(new Error('launch services offline'))
      const failed = await api.host.fileApplications({ rpcId: RpcId('native-apps-fail'), payload: { path: '/work/file.txt' } }, new AbortController().signal)
      expect(failed.result.ok).toBe(false)
    } finally { await ctx.fiber.dispose() }
  })

  it('answers an empty association list when native opening is unavailable', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    await ctx.plugin(UserQuestionService)
    const applications = vi.fn(async () => [{ id: 'com.editor.zed', name: 'Zed', default: true, icon: null }])
    const api = createApiProxy(ctx, {
      cwd: '/work', defaultModelSelection: () => ({ provider: 'p', model: 'm' }), canOpenPath: () => false,
      fileApplications: applications,
    })
    try {
      const served = await api.host.fileApplications({ rpcId: RpcId('native-apps-empty'), payload: { path: '/work/file.txt' } }, new AbortController().signal)
      expect(served.result).toEqual({ ok: true, value: { applications: [] } })
      expect(applications).not.toHaveBeenCalled()
    } finally { await ctx.fiber.dispose() }
  })
})
