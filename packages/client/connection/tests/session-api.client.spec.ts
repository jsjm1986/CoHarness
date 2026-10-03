// @vitest-environment node
import { describe, expect, it, vi } from 'vitest'
import { sessionAddressApi } from '../src/client/session-api.ts'
import { clientSessionKey } from '@deepseek-ai/dsh-host-apiproxy/api'
import { FixtureApiClient } from '../src/client/fixture.ts'
import type { SessionId } from '../src/client/api.ts'

describe('Session API routing', () => {
  it('routes exact Session fields and preserves message, path and document content', async () => {
    const base = new FixtureApiClient()
    const project = new FixtureApiClient()
    const id = 'fx-alpha' as SessionId
    const key = clientSessionKey({ kind: 'project', projectId: 7 }, id)
    const prompt = vi.spyOn(project.sessions, 'prompt').mockResolvedValue({ rpcId: 'owned' as never, result: { ok: true, value: { accepted: true } } })
    const routed = sessionAddressApi(base, (value) => {
      expect(value).toBe(key)
      return { api: project, sessionId: id }
    })
    const content = [{ type: 'text' as const, text: key }]
    await routed.sessions.prompt({ sessionId: key, content, mode: 'queue' })
    expect(prompt).toHaveBeenCalledWith({ sessionId: id, content, mode: 'queue' }, undefined)
    expect(content[0]?.text).toBe(key)
    await routed.sessions.models({ sessionId: id })
    expect(prompt).toHaveBeenCalledTimes(1)
  })
  it('refuses parent and child keys from different runtimes before any request', async () => {
    const base = new FixtureApiClient()
    const project = new FixtureApiClient()
    const parent = clientSessionKey({ kind: 'personal' }, 'same' as SessionId)
    const child = clientSessionKey({ kind: 'project', projectId: 7 }, 'same' as SessionId)
    const routed = sessionAddressApi(base, key => ({ api: key === parent ? base : project, sessionId: 'same' as SessionId }))
    expect(() => routed.subagents.history({ parentSessionId: parent, childSessionId: child, mode: 'continuable' })).toThrow('different runtimes')
  })
})

it.each([
  ['sessions', 'history'], ['sessions', 'historyIndex'], ['sessions', 'selectModel'], ['sessions', 'rename'], ['sessions', 'fork'],
  ['sessions', 'attachment'], ['sessions', 'updateQueue'], ['sessions', 'cancel'], ['desktop', 'status'], ['desktop', 'confirm'],
  ['workspace', 'archiveSession'], ['workspace', 'unarchiveSession'], ['workspace', 'insertSessionBefore'],
  ['workspace', 'pinSession'], ['workspace', 'unpinSession'],
  ['workspaceChanges', 'summary'], ['workspaceChanges', 'diff'], ['workspaceFiles', 'list'], ['workspaceFiles', 'stat'],
  ['workspaceFiles', 'read'], ['workspaceFiles', 'readBytes'], ['workspaceFiles', 'renderOffice'], ['skills', 'list'],
  ['subagents', 'history'],
])('routes the %s.%s public entry to its owner without rewriting content', async (domain, method) => {
  const base = new FixtureApiClient()
  const project = new FixtureApiClient()
  const id = 'same' as SessionId
  const key = clientSessionKey({ kind: 'project', projectId: 7 }, id)
  const sink = vi.fn(async () => ({ accepted: true }))
  Reflect.set(Reflect.get(project, domain), method, sink)
  const routed = sessionAddressApi(base, () => ({ api: project, sessionId: id }))
  const payload = domain === 'subagents' ? { parentSessionId: key, childSessionId: key, mode: 'continuable', content: key }
    : { sessionId: key, ...(method === 'confirm' ? { rootSessionId: key } : {}),
      ...(method === 'insertSessionBefore' ? { beforeSessionId: key } : {}), content: key }
  const signal = new AbortController().signal
  const invoke: unknown = Reflect.get(Reflect.get(routed, domain), method)
  if (typeof invoke !== 'function') throw new Error('Public Session operation missing')
  await Reflect.apply(invoke, undefined, [payload, signal])
  const expected = domain === 'subagents' ? { ...payload, parentSessionId: id, childSessionId: id }
    : { ...payload, sessionId: id, ...(method === 'confirm' ? { rootSessionId: id } : {}),
      ...(method === 'insertSessionBefore' ? { beforeSessionId: id } : {}) }
  expect(sink).toHaveBeenCalledWith(expected, signal)
  expect(payload.content).toBe(key)
})
