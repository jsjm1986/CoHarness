// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { SessionId } from '@deepseek-ai/dsh-session'
import { clientSessionKey, type SessionRuntimeTarget } from '@deepseek-ai/dsh-client-runtime/client'
import {
  CollaborationClient, CollaborationRequestError, createBrowserCollaborationTransport,
  parseCollaborationContext, parseConversationDetail, type CollaborationContext,
  type CollaborationTransport, type ConversationDetail, type CollaborationEnvironmentPage,
} from '../src/client/collaboration-client.ts'

afterEach(() => { localStorage.clear(); vi.restoreAllMocks() })

const projectContext: CollaborationContext = {
  user: { id: 7, username: 'lin', displayName: '林工', role: 'member' },
  scope: { kind: 'project', projectId: 9, projectName: '支付重构', mode: 'rw' },
  projects: [
    { projectId: 9, name: '支付重构', path: '/srv/pay', mode: 'rw' },
    { projectId: 10, name: '审计平台', path: '/srv/audit', mode: 'ro' },
  ],
}

const personalContext: CollaborationContext = {
  ...projectContext,
  scope: { kind: 'personal' },
}

const detail: ConversationDetail = {
  access: {
    sessionId: 'child',
    rootSessionId: 'root',
    projectId: 9,
    visibility: 'project',
    creatorUserId: 7,
    mode: 'rw',
    canRead: true,
    canWrite: true,
    canManage: true,
  },
  conversation: {
    sessionId: 'root',
    creatorUserId: 7,
    creatorDisplayName: '林工',
    visibility: 'project',
    participants: [
      { userId: 7, displayName: '林工', contributionCount: 3, lastContributedAt: 1_700_000_000_000 },
    ],
    updatedAt: 1_700_000_000_100,
  },
}

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}

function transport(overrides: Partial<CollaborationTransport> = {}): CollaborationTransport {
  return {
    loadContext: vi.fn().mockResolvedValue(projectContext),
    switchScope: vi.fn().mockResolvedValue(undefined),
    loadConversation: vi.fn().mockResolvedValue(detail),
    setVisibility: vi.fn().mockResolvedValue(undefined),
    reload: vi.fn(),
    ...overrides,
  }
}

describe('response parsing', () => {
  it('retains fixed computer metadata for an empty project and rejects invalid computer identities', () => {
    const project = { ...projectContext.projects[0], nodeId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', nodeName: 'Ubuntu' }
    expect(parseCollaborationContext({ ...projectContext, projects: [project] }).projects[0]).toMatchObject({
      nodeId: project.nodeId, nodeName: 'Ubuntu',
    })
    expect(() => parseCollaborationContext({ ...projectContext, projects: [{ ...project, nodeId: 'another-computer' }] }))
      .toThrow('invalid collaboration project computer')
  })

  it('retains explicit account eligibility and rejects malformed eligibility fields', () => {
    expect(parseCollaborationContext({ ...personalContext, fullAccess: true, autoReviewEligible: true }))
      .toMatchObject({ fullAccess: true, autoReviewEligible: true })
    expect(() => parseCollaborationContext({ ...personalContext, autoReviewEligible: 'true' }))
      .toThrow('invalid collaboration response')
    expect(() => parseCollaborationContext({ ...personalContext, fullAccess: 'true' }))
      .toThrow('invalid collaboration response')
  })
  it('accepts personal and project contexts plus full and null conversation details', () => {
    expect(parseCollaborationContext(personalContext)).toEqual(personalContext)
    expect(parseCollaborationContext(projectContext)).toEqual(projectContext)
    expect(parseConversationDetail(detail)).toEqual(detail)
    expect(parseConversationDetail({ ...detail, conversation: null })).toEqual({ ...detail, conversation: null })
  })

  it('carries steward space markers and drops unrecognized kind values', () => {
    const stewardContext = parseCollaborationContext({
      ...projectContext,
      scope: { kind: 'project', projectId: 11, projectName: '维护中枢', mode: 'rw', steward: true },
      projects: [
        { projectId: 9, name: '支付重构', path: '/srv/pay', mode: 'rw' },
        { projectId: 11, name: '维护中枢', path: '/srv/steward', mode: 'rw', kind: 'steward' },
      ],
    })
    expect(stewardContext.scope).toMatchObject({ kind: 'project', projectId: 11, steward: true })
    expect(stewardContext.projects[1]).toMatchObject({ projectId: 11, kind: 'steward' })
    expect(stewardContext.projects[0]).not.toHaveProperty('kind')

    // Unknown future kinds and non-boolean steward flags stay inert for this build.
    const future = parseCollaborationContext({
      ...projectContext,
      scope: { kind: 'project', projectId: 9, projectName: '支付重构', mode: 'rw', steward: 'yes' },
      projects: [{ projectId: 9, name: '支付重构', path: '/srv/pay', mode: 'rw', kind: 'archive' }],
    })
    expect(future.scope).not.toHaveProperty('steward')
    expect(future.projects[0]).not.toHaveProperty('kind')
  })

  it('rejects malformed account-context fields at the HTTP boundary', () => {
    const invalid: unknown[] = [
      null,
      [],
      { ...projectContext, user: 'bad' },
      { ...projectContext, user: { ...projectContext.user, id: -1 } },
      { ...projectContext, user: { ...projectContext.user, username: 1 } },
      { ...projectContext, user: { ...projectContext.user, displayName: null } },
      { ...projectContext, user: { ...projectContext.user, role: false } },
      { ...projectContext, scope: { kind: 'other' } },
      { ...projectContext, scope: { kind: 'project', projectId: 1.5, projectName: 'x', mode: 'rw' } },
      { ...projectContext, scope: { kind: 'project', projectId: 1, projectName: 2, mode: 'rw' } },
      { ...projectContext, scope: { kind: 'project', projectId: 1, projectName: 'x', mode: 'owner' } },
      { ...projectContext, projects: null },
      { ...projectContext, projects: [{ projectId: 1, name: 'x', path: 2, mode: 'rw' }] },
      { ...projectContext, projects: [{ projectId: 1, name: 'x', path: '/x', mode: 'owner' }] },
    ]
    for (const value of invalid) expect(() => parseCollaborationContext(value)).toThrow('invalid collaboration response')
  })

  it('rejects malformed conversation detail fields at the HTTP boundary', () => {
    const invalid: unknown[] = [
      1,
      { ...detail, access: null },
      { ...detail, access: { ...detail.access, canRead: false } },
      { ...detail, access: { ...detail.access, sessionId: null } },
      { ...detail, access: { ...detail.access, rootSessionId: 1 } },
      { ...detail, access: { ...detail.access, projectId: Number.NaN } },
      { ...detail, access: { ...detail.access, visibility: 'personal' } },
      { ...detail, access: { ...detail.access, creatorUserId: -1 } },
      { ...detail, access: { ...detail.access, mode: 'owner' } },
      { ...detail, access: { ...detail.access, canWrite: 'yes' } },
      { ...detail, access: { ...detail.access, canManage: 1 } },
      { ...detail, conversation: { ...detail.conversation, participants: null } },
      { ...detail, conversation: { ...detail.conversation, sessionId: 1, participants: [] } },
      { ...detail, conversation: { ...detail.conversation, creatorUserId: -1, participants: [] } },
      { ...detail, conversation: { ...detail.conversation, creatorDisplayName: 1, participants: [] } },
      { ...detail, conversation: { ...detail.conversation, visibility: 'personal', participants: [] } },
      { ...detail, conversation: { ...detail.conversation, updatedAt: -1, participants: [] } },
      { ...detail, conversation: { ...detail.conversation, participants: [{
        userId: 1, displayName: 'x', contributionCount: -1, lastContributedAt: 1,
      }] } },
      { ...detail, conversation: { ...detail.conversation, participants: [{
        userId: 1, displayName: 'x', contributionCount: 1, lastContributedAt: 'now',
      }] } },
    ]
    for (const value of invalid) expect(() => parseConversationDetail(value)).toThrow('invalid collaboration response')
  })
})

describe('browser transport', () => {
  it('pins sharing reads and changes to each Session Runtime independently of the active page', async () => {
    const first = { kind: 'project', projectId: 9,
      runtimeId: '10000000-0000-4000-8000-000000000001' as NonNullable<SessionRuntimeTarget['runtimeId']> } satisfies SessionRuntimeTarget
    const second = { kind: 'project', projectId: 10,
      runtimeId: '10000000-0000-4000-8000-000000000002' as NonNullable<SessionRuntimeTarget['runtimeId']> } satisfies SessionRuntimeTarget
    const fetcher = vi.fn().mockResolvedValueOnce(Response.json(detail))
      .mockResolvedValueOnce(new Response(null, { status: 204 })) as unknown as typeof fetch
    const api = createBrowserCollaborationTransport({ fetch: fetcher })
    const signal = new AbortController().signal
    await api.loadConversation(clientSessionKey(first, SessionId('same-session')), signal)
    await api.setVisibility(clientSessionKey(second, SessionId('same-session')), 'private', signal)
    for (const [index, target] of [first, second].entries()) {
      const url = new URL(vi.mocked(fetcher).mock.calls[index]![0] as string, 'http://gateway')
      expect(url.pathname).toBe('/account/api/conversations/same-session')
      expect(url.searchParams.get('projectId')).toBe(String(target.projectId))
      expect(url.searchParams.get('dshRuntime')).toBe(target.runtimeId)
      expect(url.searchParams.get('dshTarget')).toBe(`project:${String(target.projectId)}`)
    }
  })

  it('keeps an unqualified sharing request on the Runtime explicitly selected in this tab', async () => {
    const previous = location.href
    const runtimeId = '10000000-0000-4000-8000-000000000003'
    history.replaceState(null, '', `/?dshRuntime=${runtimeId}`)
    try {
      const fetcher = vi.fn().mockResolvedValue(Response.json(detail)) as unknown as typeof fetch
      const api = createBrowserCollaborationTransport({ fetch: fetcher })
      await api.loadConversation('legacy-session', new AbortController().signal)
      const url = new URL(vi.mocked(fetcher).mock.calls[0]![0] as string, 'http://gateway')
      expect(url.searchParams.get('dshRuntime')).toBe(runtimeId)
    } finally {
      history.replaceState(null, '', previous)
    }
  })

  it('uses the Gateway account routes, encodes session ids, and reloads through the injected callback', async () => {
    const fetcher = vi.fn()
      .mockResolvedValueOnce(Response.json(projectContext))
      .mockResolvedValueOnce(new Response(null, { status: 204 }))
      .mockResolvedValueOnce(Response.json(detail))
      .mockResolvedValueOnce(new Response(null, { status: 204 })) as unknown as typeof fetch
    const reload = vi.fn()
    const api = createBrowserCollaborationTransport({ fetch: fetcher, reload })
    const signal = new AbortController().signal

    await expect(api.loadContext(signal)).resolves.toEqual(projectContext)
    await expect(api.switchScope({ kind: 'project', projectId: 9 }, signal)).resolves.toBeUndefined()
    await expect(api.loadConversation('root/child', signal)).resolves.toEqual(detail)
    await expect(api.setVisibility('root/child', 'private', signal)).resolves.toBeUndefined()
    api.reload()

    expect(fetcher).toHaveBeenNthCalledWith(1, '/account/api/context', {
      credentials: 'same-origin', signal,
    })
    expect(fetcher).toHaveBeenNthCalledWith(2, '/account/api/scope', {
      credentials: 'same-origin', method: 'POST', signal,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ kind: 'project', projectId: 9 }),
    })
    expect(fetcher).toHaveBeenNthCalledWith(3, '/account/api/conversations/root%2Fchild', {
      credentials: 'same-origin', signal,
    })
    expect(fetcher).toHaveBeenNthCalledWith(4, '/account/api/conversations/root%2Fchild', {
      credentials: 'same-origin', method: 'PATCH', signal,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ visibility: 'private' }),
    })
    expect(reload).toHaveBeenCalledOnce()
  })

  it('uses the account project and invitation routes', async () => {
    const invitation = {
      id: 'invite-1', projectId: 9, projectName: '支付重构',
      invitee: { id: 8, username: 'zhou', displayName: '周工' },
      inviter: { id: 7, username: 'lin', displayName: '林工' },
      mode: 'rw', status: 'pending', expiresAt: null,
      createdAt: '2026-08-16T00:00:00.000Z', respondedAt: null,
    }
    const fetcher = vi.fn()
      .mockResolvedValueOnce(Response.json({ id: 12 }))
      .mockResolvedValueOnce(Response.json([invitation]))
      .mockResolvedValueOnce(Response.json(invitation))
      .mockResolvedValueOnce(new Response(null, { status: 204 })) as unknown as typeof fetch
    const api = createBrowserCollaborationTransport({ fetch: fetcher, reload: vi.fn() })
    const signal = new AbortController().signal

    await expect(api.createProject?.('新项目', signal)).resolves.toEqual({ projectId: 12 })
    await expect(api.listInvitations?.(undefined, signal)).resolves.toEqual([invitation])
    await expect(api.inviteMember?.(9, 'zhou', 'rw', signal)).resolves.toEqual(invitation)
    await expect(api.acceptInvitation?.('invite/1', signal)).resolves.toBeUndefined()
    expect(fetcher).toHaveBeenNthCalledWith(1, '/account/api/projects', expect.objectContaining({ method: 'POST' }))
    expect(fetcher).toHaveBeenNthCalledWith(2, '/account/api/invitations', expect.objectContaining({ credentials: 'same-origin' }))
    expect(fetcher).toHaveBeenNthCalledWith(3, '/account/api/projects/9/invitations', expect.objectContaining({ method: 'POST' }))
    expect(fetcher).toHaveBeenNthCalledWith(4, '/account/api/invitations/invite%2F1/accept', expect.objectContaining({ method: 'POST' }))
  })

  it('uses the user picker and pending-invitation count routes', async () => {
    const fetcher = vi.fn()
      .mockResolvedValueOnce(Response.json([
        { id: 7, username: 'lin', displayName: '林工' },
        { id: 8, username: 'zhou', displayName: '周工' },
      ]))
      .mockResolvedValueOnce(Response.json({ pending: 2 })) as unknown as typeof fetch
    const api = createBrowserCollaborationTransport({ fetch: fetcher, reload: vi.fn() })
    const signal = new AbortController().signal

    await expect(api.listUsers?.(signal)).resolves.toEqual([
      { id: 7, username: 'lin', displayName: '林工' },
      { id: 8, username: 'zhou', displayName: '周工' },
    ])
    await expect(api.getInvitationCount?.(signal)).resolves.toEqual({ pending: 2 })
    expect(fetcher).toHaveBeenNthCalledWith(1, '/account/api/users', { credentials: 'same-origin', signal })
    expect(fetcher).toHaveBeenNthCalledWith(2, '/account/api/invitations/count', { credentials: 'same-origin', signal })
  })

  it('uses the project SSH target routes', async () => {
    const target = { publicId: 41, name: 'builder', host: 'ssh-builder', workspace: '/srv/workspaces', enabled: true, shared: true }
    const fetcher = vi.fn()
      .mockResolvedValueOnce(Response.json({ targets: [target] }))
      .mockResolvedValueOnce(Response.json({ publicId: 41, name: 'builder', shared: false })) as unknown as typeof fetch
    const api = createBrowserCollaborationTransport({ fetch: fetcher, reload: vi.fn() })
    const signal = new AbortController().signal

    await expect(api.listProjectSshTargets?.(9, signal)).resolves.toEqual([target])
    await expect(api.shareProjectSshTarget?.(9, 41, false, signal)).resolves.toEqual({ publicId: 41, name: 'builder', shared: false })
    expect(fetcher).toHaveBeenNthCalledWith(1, '/account/api/projects/9/ssh-targets', {
      credentials: 'same-origin', signal,
    })
    expect(fetcher).toHaveBeenNthCalledWith(2, '/account/api/projects/9/ssh-targets', {
      credentials: 'same-origin', method: 'POST', signal,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ targetId: 41, shared: false }),
    })
  })

  it('rejects malformed project SSH target responses at the HTTP boundary', async () => {
    for (const body of [{ targets: 'x' }, { targets: null }]) {
      const fetcher = vi.fn().mockResolvedValueOnce(Response.json(body)) as unknown as typeof fetch
      const api = createBrowserCollaborationTransport({ fetch: fetcher, reload: vi.fn() })
      await expect(api.listProjectSshTargets?.(9, new AbortController().signal)).rejects.toThrow('invalid ssh target response')
    }
    for (const body of [null, [], { targets: [41] }, { targets: [{ publicId: 'bad' }] }]) {
      const fetcher = vi.fn().mockResolvedValueOnce(Response.json(body)) as unknown as typeof fetch
      const api = createBrowserCollaborationTransport({ fetch: fetcher, reload: vi.fn() })
      await expect(api.listProjectSshTargets?.(9, new AbortController().signal)).rejects.toThrow('invalid collaboration response')
    }
    const fetcher = vi.fn().mockResolvedValueOnce(Response.json({ publicId: 'bad', name: 'x', shared: false })) as unknown as typeof fetch
    const api = createBrowserCollaborationTransport({ fetch: fetcher, reload: vi.fn() })
    await expect(api.shareProjectSshTarget?.(9, 41, true, new AbortController().signal)).rejects.toThrow('invalid collaboration response')
  })

  it('rejects malformed user picker and invitation count responses at the HTTP boundary', async () => {
    const invalidUserLists: unknown[] = [null, 1, [1], [{ id: 'bad', username: 'x', displayName: 'x' }]]
    for (const body of invalidUserLists) {
      const fetcher = vi.fn().mockResolvedValueOnce(Response.json(body)) as unknown as typeof fetch
      const api = createBrowserCollaborationTransport({ fetch: fetcher, reload: vi.fn() })
      await expect(api.listUsers?.(new AbortController().signal)).rejects.toThrow('invalid collaboration response')
    }
    const invalidCounts: unknown[] = [null, [], { pending: 'many' }, { pending: 1.5 }]
    for (const body of invalidCounts) {
      const fetcher = vi.fn().mockResolvedValueOnce(Response.json(body)) as unknown as typeof fetch
      const api = createBrowserCollaborationTransport({ fetch: fetcher, reload: vi.fn() })
      await expect(api.getInvitationCount?.(new AbortController().signal)).rejects.toThrow('invalid collaboration response')
    }
  })

  it('retains machine error codes and tolerates malformed error bodies', async () => {
    const fetcher = vi.fn()
      .mockResolvedValueOnce(Response.json({ error: 'visibility-locked' }, { status: 409 }))
      .mockResolvedValueOnce(Response.json({ error: 1 }, { status: 500 }))
      .mockResolvedValueOnce(new Response('not-json', { status: 502 })) as unknown as typeof fetch
    const api = createBrowserCollaborationTransport({ fetch: fetcher, reload: vi.fn() })
    const signal = new AbortController().signal

    await expect(api.setVisibility('s', 'private', signal)).rejects.toEqual(
      new CollaborationRequestError(409, 'visibility-locked'),
    )
    await expect(api.switchScope({ kind: 'personal' }, signal)).rejects.toEqual(
      new CollaborationRequestError(500),
    )
    await expect(api.loadConversation('s', signal)).rejects.toEqual(
      new CollaborationRequestError(502),
    )
  })

  it('uses browser defaults when no transport overrides are supplied', () => {
    const original = globalThis.fetch
    const fake = vi.fn() as unknown as typeof fetch
    globalThis.fetch = fake
    try {
      const api = createBrowserCollaborationTransport()
      expect(api.loadContext).toBeTypeOf('function')
      expect(api.reload).toBeTypeOf('function')
    } finally {
      globalThis.fetch = original
    }
  })
})

describe('CollaborationClient', () => {
  it('retains loaded destinations across pages and resets them on an explicit refresh', async () => {
    const first = { target: { kind: 'personal' as const, runtimeId: '10000000-0000-4000-8000-000000000001' as never }, name: 'Lin', nodeName: 'A', observedState: 'ready' }
    const second = { ...first, target: { kind: 'personal' as const, runtimeId: '10000000-0000-4000-8000-000000000002' as never }, nodeName: 'B' }
    const loadEnvironments = vi.fn().mockResolvedValueOnce({ items: [first], nextCursor: 'next' })
      .mockResolvedValueOnce({ items: [first, second], nextCursor: null })
      .mockResolvedValueOnce({ items: [second], nextCursor: null })
    const client = new CollaborationClient(transport({ loadEnvironments }))
    await client.load()
    await client.loadEnvironments()
    await client.loadEnvironments('next')
    expect(client.getSnapshot().environments?.items).toEqual([first, second])
    await client.loadEnvironments()
    expect(client.getSnapshot().environments?.items).toEqual([second])
    client.dispose()
  })

  it('resolves a favorite beyond the first page and drops its metadata when access is withdrawn', async () => {
    const id = '10000000-0000-4000-8000-000000000009'
    localStorage.setItem(`dsh.spaces.favorite.v1.account:7.runtime:${id}`, '1')
    const favorite = { target: { kind: 'personal' as const, runtimeId: id as never }, name: 'Lin', nodeName: 'Computer B', observedState: 'stopped' }
    const resolve = vi.fn().mockResolvedValueOnce([favorite]).mockResolvedValueOnce([])
    const client = new CollaborationClient(transport({
      loadEnvironments: async () => ({ items: [], nextCursor: 'later' }), loadPreferredEnvironments: resolve,
    }))
    try {
      await client.load()
      await client.loadEnvironments()
      expect(resolve).toHaveBeenCalledWith([id], expect.any(AbortSignal))
      expect(client.getSnapshot().preferredEnvironments).toEqual([favorite])
      expect(client.getSnapshot().favoriteRuntimeIds).toEqual([id])
      await client.loadEnvironments()
      expect(client.getSnapshot().preferredEnvironments).toEqual([])
      expect(client.getSnapshot().favoriteRuntimeIds).toEqual([])
    } finally { client.dispose() }
  })

  it('cancels saved-destination metadata on connection invalidation and ignores its late completion', async () => {
    const id = '10000000-0000-4000-8000-000000000009'
    localStorage.setItem(`dsh.spaces.favorite.v1.account:7.runtime:${id}`, '1')
    let finish!: (items: []) => void
    let signal!: AbortSignal
    const client = new CollaborationClient(transport({
      loadEnvironments: async () => ({ items: [], nextCursor: null }),
      loadPreferredEnvironments: (_ids, owned) => { signal = owned; return new Promise((resolve) => { finish = resolve }) },
    }))
    try {
      await client.load()
      const loading = client.loadEnvironments()
      client.invalidateContext()
      expect(signal.aborted).toBe(true)
      finish([])
      await loading
      expect(client.getSnapshot().preferredEnvironments).toBeUndefined()
      expect(client.getSnapshot().favoriteRuntimeIds).toBeUndefined()
    } finally { client.dispose() }
  })

  it.each([
    [503, 'node-service/unavailable', 'offline'], [503, 'node-service/busy', 'busy'],
    [409, 'runtime-management/quota-exceeded', 'quota'], [403, 'runtime-catalog/forbidden', 'forbidden'],
    [401, undefined, 'auth'], [404, undefined, 'retired'],
  ])('retains a recoverable switch refusal for status %s and code %s', async (status, code, reason) => {
    const client = new CollaborationClient(transport({
      switchScope: async () => { throw new CollaborationRequestError(status, code) },
    }))
    try {
      await client.load()
      await client.switchScope({ kind: 'personal' })
      expect(client.getSnapshot()).toMatchObject({ scopeBusy: false, scopeError: reason, scopeFailedTarget: { kind: 'personal' } })
    } finally { client.dispose() }
  })

  it('prepares the destination while preserving transient input in the source tab', async () => {
    const runtimeId = '10000000-0000-4000-8000-000000000002'
    let mayLeave = false
    const reload = vi.fn()
    const client = new CollaborationClient(transport({
      canNavigate: () => mayLeave, reload,
      loadEnvironments: vi.fn().mockResolvedValue({ items: [{ target: { kind: 'personal', runtimeId },
        name: 'lin', nodeName: 'Computer B', observedState: 'ready' }], nextCursor: null }),
      switchScope: vi.fn().mockResolvedValue(`/?dshRuntime=${runtimeId}`),
    }))
    await client.load()
    await client.loadEnvironments()
    await client.switchScope({ kind: 'personal', runtimeId: runtimeId as never })
    expect(reload).not.toHaveBeenCalled()
    expect(client.getSnapshot().scopeOffer?.runtimeId).toBe(runtimeId)
    expect(client.getSnapshot().scopeOffer?.target.nodeName).toBe('Computer B')
    expect(client.getSnapshot().scopeBusy).toBe(false)
    client.dismissScopeOffer()
    expect(client.getSnapshot().scopeOffer).toBeUndefined()
    mayLeave = true
    await client.switchScope({ kind: 'personal', runtimeId: runtimeId as never })
    expect(reload).toHaveBeenCalledWith(`/?dshRuntime=${runtimeId}`)
    client.dispose()
  })

  it('does not navigate when account verification is invalidated during preparation', async () => {
    const pending = deferred<string>()
    const switchScope = vi.fn().mockReturnValue(pending.promise)
    const reload = vi.fn()
    const client = new CollaborationClient(transport({ switchScope, reload }))
    await client.load()
    const request = client.switchScope({ kind: 'project', projectId: 9 })
    client.invalidateContext()
    expect((switchScope.mock.calls[0]![1] as AbortSignal).aborted).toBe(true)
    pending.resolve('/?dshRuntime=10000000-0000-4000-8000-000000000002')
    await request
    expect(reload).not.toHaveBeenCalled()
    expect(client.getSnapshot().scopeBusy).toBe(false)
    expect(client.getSnapshot().scopeOffer).toBeUndefined()
    client.dispose()
  })

  it('waits for verified account context before reading environment metadata', async () => {
    const loadEnvironments = vi.fn().mockResolvedValue({ items: [], nextCursor: null })
    const client = new CollaborationClient(transport({ loadEnvironments }))
    await client.loadEnvironments()
    expect(loadEnvironments).not.toHaveBeenCalled()
    await client.load()
    await client.loadEnvironments('page-2')
    expect(client.getSnapshot().environmentsCursor).toBe('page-2')
    client.dispose()
  })

  it('aborts old environment reads and refuses their late result after the account changes', async () => {
    const old = deferred<CollaborationEnvironmentPage>()
    const loadContext = vi.fn().mockResolvedValueOnce(personalContext)
      .mockResolvedValueOnce({ ...personalContext, user: { ...personalContext.user, id: 8 } })
    const loadEnvironments = vi.fn().mockReturnValueOnce(old.promise).mockResolvedValueOnce({ items: [], nextCursor: null })
    const client = new CollaborationClient(transport({ loadContext, loadEnvironments }))
    await client.load()
    const obsolete = client.loadEnvironments()
    await vi.waitFor(() => { expect(loadEnvironments).toHaveBeenCalledTimes(1) })
    const signal = loadEnvironments.mock.calls[0]![1] as AbortSignal
    await client.load(true)
    expect(signal.aborted).toBe(true)
    await client.loadEnvironments()
    old.resolve({ items: [], nextCursor: 'old-account-cursor' })
    await obsolete
    expect(client.getSnapshot().environments).toEqual({ items: [], nextCursor: null })
    client.dispose()
  })

  it('aborts the pending directory on connection invalidation and releases its loading state', async () => {
    const pending = deferred<CollaborationEnvironmentPage>()
    const loadEnvironments = vi.fn().mockReturnValue(pending.promise)
    const client = new CollaborationClient(transport({ loadEnvironments }))
    await client.load()
    const read = client.loadEnvironments()
    await vi.waitFor(() => { expect(loadEnvironments).toHaveBeenCalledTimes(1) })
    client.invalidateContext()
    expect((loadEnvironments.mock.calls[0]![1] as AbortSignal).aborted).toBe(true)
    pending.resolve({ items: [], nextCursor: 'old-connection' })
    await read
    expect(client.getSnapshot().environments).toBeUndefined()
    expect(client.getSnapshot().environmentsLoading).toBe(false)
    client.dispose()
  })

  it('ignores an earlier connection generation after the account context was invalidated', async () => {
    const old = deferred<CollaborationContext>()
    const fresh = deferred<CollaborationContext>()
    const loadContext = vi.fn().mockReturnValueOnce(old.promise).mockReturnValueOnce(fresh.promise)
    const client = new CollaborationClient(transport({ loadContext }))
    const first = client.load()
    client.invalidateContext()
    const second = client.load(true)
    old.resolve({ ...personalContext, fullAccess: true, autoReviewEligible: true })
    await first
    expect(client.getSnapshot()).toMatchObject({ contextVerified: false })
    fresh.resolve({ ...personalContext, fullAccess: false, autoReviewEligible: false })
    await second
    expect(client.getSnapshot()).toMatchObject({ contextVerified: true, context: { fullAccess: false, autoReviewEligible: false } })
    client.dispose()
  })
  it('withdraws verified account eligibility while refreshing and after an HTTP failure', async () => {
    const pending = deferred<CollaborationContext>()
    const loadContext = vi.fn().mockResolvedValueOnce({ ...personalContext, autoReviewEligible: true })
      .mockReturnValueOnce(pending.promise)
    const client = new CollaborationClient(transport({ loadContext }))
    await client.load()
    expect(client.getSnapshot()).toMatchObject({ contextVerified: true })
    const refresh = client.load(true)
    expect(client.getSnapshot()).toMatchObject({ contextVerified: false })
    pending.reject(new CollaborationRequestError(503))
    await refresh
    expect(client.getSnapshot()).toMatchObject({ contextVerified: false })
  })
  it('coalesces context loads, publishes project context, stages visibility, and clears details in personal scope', async () => {
    const first = deferred<CollaborationContext>()
    const loadContext = vi.fn().mockReturnValueOnce(first.promise).mockResolvedValueOnce(personalContext)
    const api = transport({ loadContext })
    const client = new CollaborationClient(api)
    const listener = vi.fn()
    const unsubscribe = client.subscribe(listener)

    const one = client.load()
    const two = client.load()
    expect(one).toBe(two)
    expect(client.getSnapshot().status).toBe('loading')
    first.resolve(projectContext)
    await one
    expect(client.getSnapshot()).toMatchObject({ status: 'ready', context: projectContext })
    client.stageVisibility('private')
    expect(client.getSnapshot().stagedVisibility).toBe('private')
    await client.loadConversation('child')
    expect(client.getSnapshot().conversations.child?.status).toBe('ready')
    await client.load()
    expect(client.getSnapshot()).toMatchObject({ status: 'ready', context: personalContext, conversations: {} })
    expect(listener).toHaveBeenCalled()
    unsubscribe()
  })

  it('marks an initial context failure unavailable but preserves ready data on refresh failure', async () => {
    const loadContext = vi.fn()
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValueOnce(projectContext)
      .mockRejectedValueOnce(new Error('offline again'))
    const client = new CollaborationClient(transport({ loadContext }))
    await client.load()
    expect(client.getSnapshot().status).toBe('unavailable')
    await client.load()
    expect(client.getSnapshot().status).toBe('ready')
    await client.load()
    expect(client.getSnapshot()).toMatchObject({ status: 'ready', context: projectContext })
  })

  it('switches scope once, reloads on success, and surfaces a retryable failure', async () => {
    const pending = deferred<undefined>()
    const switchScope = vi.fn().mockReturnValueOnce(pending.promise).mockRejectedValueOnce(new Error('denied'))
    const reload = vi.fn()
    const client = new CollaborationClient(transport({ switchScope, reload }))
    await client.load()
    const first = client.switchScope({ kind: 'project', projectId: 9 })
    await client.switchScope({ kind: 'personal' })
    expect(switchScope).toHaveBeenCalledTimes(1)
    expect(client.getSnapshot()).toMatchObject({
      scopeBusy: true,
      scopeTarget: { kind: 'project', projectId: 9, projectName: '支付重构' },
    })
    pending.resolve(undefined)
    await first
    expect(reload).toHaveBeenCalledOnce()
    expect(client.getSnapshot().scopeBusy).toBe(false)
    expect(client.getSnapshot()).not.toHaveProperty('scopeTarget')
    await client.switchScope({ kind: 'personal' })
    expect(client.getSnapshot()).toMatchObject({ scopeBusy: false, scopeError: 'switch-failed' })
    expect(client.getSnapshot()).not.toHaveProperty('scopeTarget')
  })

  it('loads, coalesces, retries, and rejects conversation detail outside project scope', async () => {
    const pending = deferred<ConversationDetail>()
    const loadConversation = vi.fn()
      .mockReturnValueOnce(pending.promise)
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValueOnce(detail)
    const client = new CollaborationClient(transport({ loadConversation }))
    await client.load()
    const first = client.loadConversation('child')
    await client.loadConversation('child')
    expect(loadConversation).toHaveBeenCalledTimes(1)
    pending.resolve(detail)
    await first
    await client.loadConversation('child')
    expect(loadConversation).toHaveBeenCalledTimes(1)

    await client.loadConversation('retry')
    expect(client.getSnapshot().conversations.retry).toEqual({
      status: 'error', saving: false, error: 'load-failed',
    })
    await client.loadConversation('retry')
    expect(client.getSnapshot().conversations.retry?.status).toBe('ready')

    const personal = new CollaborationClient(transport({ loadContext: vi.fn().mockResolvedValue(personalContext), loadConversation }))
    await personal.load()
    await personal.loadConversation('hidden')
    expect(loadConversation).toHaveBeenCalledTimes(3)
  })

  it('coalesces forced refreshes, retains ready detail while loading, and publishes the trailing result', async () => {
    const first = deferred<ConversationDetail>()
    const second = deferred<ConversationDetail>()
    const refreshed = {
      ...detail,
      conversation: {
        ...detail.conversation!,
        participants: [
          ...detail.conversation!.participants,
          { userId: 8, displayName: '周工', contributionCount: 1, lastContributedAt: 1_700_000_000_200 },
        ],
      },
    }
    const loadConversation = vi.fn()
      .mockResolvedValueOnce(detail)
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise)
    const client = new CollaborationClient(transport({ loadConversation }))
    await client.load()
    await client.loadConversation('child')

    const refresh = client.loadConversation('child', { force: true })
    const coalesced = client.loadConversation('child', { force: true })
    expect(coalesced).toBe(refresh)
    expect(client.getSnapshot().conversations.child).toMatchObject({ status: 'ready', detail })
    first.resolve(detail)
    await vi.waitFor(() => { expect(loadConversation).toHaveBeenCalledTimes(3) })
    second.resolve(refreshed)
    await refresh
    expect(client.getSnapshot().conversations.child).toMatchObject({
      status: 'ready', detail: refreshed,
    })
  })

  it('refreshes cached project conversations after reloading account context', async () => {
    const loadConversation = vi.fn().mockResolvedValue(detail)
    const loadContext = vi.fn().mockResolvedValue(projectContext)
    const client = new CollaborationClient(transport({ loadContext, loadConversation }))
    await client.load()
    await client.loadConversation('child')
    await client.refresh()
    expect(loadContext).toHaveBeenCalledTimes(2)
    expect(loadConversation).toHaveBeenCalledTimes(2)
  })

  it('matches only settled authoritative conversation visibility', async () => {
    const loadConversation = vi.fn()
      .mockResolvedValueOnce(detail)
      .mockRejectedValueOnce(new Error('stale refresh failed'))
      .mockRejectedValueOnce(new Error('offline'))
    const client = new CollaborationClient(transport({ loadConversation }))
    await client.load()

    await expect(client.matchesConversationVisibility('matching', 'project')).resolves.toBe(true)
    await expect(client.matchesConversationVisibility('matching', 'private')).resolves.toBe(false)
    await expect(client.matchesConversationVisibility('failed', 'project')).resolves.toBe(false)
  })

  it('delegates user listing and pending-invitation counts to the transport', async () => {
    const listUsers = vi.fn().mockResolvedValue([{ id: 8, username: 'zhou', displayName: '周工' }])
    const getInvitationCount = vi.fn().mockResolvedValue({ pending: 1 })
    const client = new CollaborationClient(transport({ listUsers, getInvitationCount }))
    await expect(client.listUsers()).resolves.toEqual([{ id: 8, username: 'zhou', displayName: '周工' }])
    await expect(client.getInvitationCount()).resolves.toEqual({ pending: 1 })

    const bare = new CollaborationClient(transport())
    await expect(bare.listUsers()).rejects.toEqual(new CollaborationRequestError(503, 'users-unavailable'))
    await expect(bare.getInvitationCount()).rejects.toEqual(new CollaborationRequestError(503, 'invitations-unavailable'))

    bare.dispose()
    await expect(bare.listUsers()).resolves.toEqual([])
    await expect(bare.getInvitationCount()).resolves.toEqual({ pending: 0 })
  })

  it('delegates project SSH target operations and degrades when the transport omits them', async () => {
    const rows = [{ publicId: 41, name: 'builder', host: 'h', workspace: '/w', enabled: true, shared: true }]
    const listProjectSshTargets = vi.fn().mockResolvedValue(rows)
    const shareProjectSshTarget = vi.fn().mockResolvedValue({ publicId: 41, name: 'builder', shared: false })
    const client = new CollaborationClient(transport({ listProjectSshTargets, shareProjectSshTarget }))
    await expect(client.listProjectSshTargets(9)).resolves.toEqual(rows)
    await expect(client.shareProjectSshTarget(9, 41, false)).resolves.toEqual({ publicId: 41, name: 'builder', shared: false })
    expect(listProjectSshTargets).toHaveBeenCalledWith(9, expect.any(AbortSignal))
    expect(shareProjectSshTarget).toHaveBeenCalledWith(9, 41, false, expect.any(AbortSignal))

    const bare = new CollaborationClient(transport())
    await expect(bare.listProjectSshTargets(9)).rejects.toEqual(new CollaborationRequestError(503, 'ssh-targets-unavailable'))
    await expect(bare.shareProjectSshTarget(9, 41, true)).rejects.toEqual(new CollaborationRequestError(503, 'ssh-targets-unavailable'))
  })

  it('rejects visibility reuse while saving or after disposal', async () => {
    const visibilityPending = deferred<undefined>()
    const loadConversation = vi.fn().mockResolvedValue(detail)
    const client = new CollaborationClient(transport({
      loadConversation,
      setVisibility: vi.fn().mockReturnValue(visibilityPending.promise),
    }))
    await client.load()
    await client.loadConversation('saving')
    const save = client.setVisibility('saving', 'private')
    await expect(client.matchesConversationVisibility('saving', 'project')).resolves.toBe(false)
    visibilityPending.resolve(undefined)
    await save
    await vi.waitFor(() => { expect(loadConversation).toHaveBeenCalledTimes(2) })

    client.dispose()
    await expect(client.matchesConversationVisibility('saving', 'private')).resolves.toBe(false)

    const detailPending = deferred<ConversationDetail>()
    const racing = new CollaborationClient(transport({
      loadConversation: vi.fn().mockReturnValue(detailPending.promise),
    }))
    await racing.load()
    const match = racing.matchesConversationVisibility('racing', 'project')
    racing.dispose()
    detailPending.resolve(detail)
    await expect(match).resolves.toBe(false)
  })

  it('updates visibility, including null conversation metadata and Gateway lock failures', async () => {
    const setVisibility = vi.fn()
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new CollaborationRequestError(409, 'visibility-locked'))
      .mockRejectedValueOnce(new Error('offline'))
    const loadConversation = vi.fn()
      .mockResolvedValueOnce(detail)
      .mockResolvedValueOnce({ ...detail, conversation: null })
      .mockResolvedValueOnce(detail)
      .mockResolvedValueOnce(detail)
    const client = new CollaborationClient(transport({ setVisibility, loadConversation }))
    await client.load()

    await client.setVisibility('missing', 'private')
    await client.loadConversation('one')
    await client.setVisibility('one', 'project')
    await client.setVisibility('one', 'private')
    expect(client.getSnapshot().conversations.one).toMatchObject({
      status: 'ready', saving: false,
      detail: { access: { visibility: 'private' }, conversation: { visibility: 'private' } },
    })

    await client.loadConversation('two')
    await client.setVisibility('two', 'private')
    expect(client.getSnapshot().conversations.two).toMatchObject({
      status: 'ready', detail: { access: { visibility: 'private' }, conversation: null },
    })

    await client.loadConversation('locked')
    await client.setVisibility('locked', 'private')
    expect(client.getSnapshot().conversations.locked).toMatchObject({
      status: 'ready', saving: false, error: 'visibility-locked',
    })
    await client.loadConversation('offline')
    await client.setVisibility('offline', 'private')
    expect(client.getSnapshot().conversations.offline).toMatchObject({
      status: 'ready', saving: false, error: 'update-failed',
    })
  })

  it('does not mutate visibility without management rights, during a save, or after disposal', async () => {
    const pending = deferred<undefined>()
    const setVisibility = vi.fn().mockReturnValue(pending.promise)
    const cannotManage: ConversationDetail = {
      ...detail,
      access: { ...detail.access, canManage: false },
    }
    const loadConversation = vi.fn()
      .mockResolvedValueOnce(cannotManage)
      .mockResolvedValueOnce(detail)
    const client = new CollaborationClient(transport({ setVisibility, loadConversation }))
    await client.load()
    await client.loadConversation('readonly')
    await client.setVisibility('readonly', 'private')
    expect(setVisibility).not.toHaveBeenCalled()

    await client.loadConversation('saving')
    const save = client.setVisibility('saving', 'private')
    await client.setVisibility('saving', 'private')
    expect(setVisibility).toHaveBeenCalledTimes(1)
    client.dispose()
    client.dispose()
    pending.resolve(undefined)
    await save
    await client.load()
    await client.loadConversation('after')
    await client.switchScope({ kind: 'personal' })
    await client.setVisibility('saving', 'project')
    expect(client.getSnapshot().conversations.saving).toMatchObject({ status: 'ready', saving: true })
  })

  it('suppresses context, conversation, and scope publications after disposal during requests', async () => {
    const contextPending = deferred<CollaborationContext>()
    const detailPending = deferred<ConversationDetail>()
    const scopePending = deferred<undefined>()
    const client = new CollaborationClient(transport({
      loadContext: vi.fn().mockReturnValueOnce(contextPending.promise).mockResolvedValueOnce(projectContext),
      loadConversation: vi.fn().mockReturnValue(detailPending.promise),
      switchScope: vi.fn().mockReturnValue(scopePending.promise),
    }))
    const contextLoad = client.load()
    client.dispose()
    contextPending.resolve(projectContext)
    await contextLoad
    expect(client.getSnapshot().status).toBe('loading')

    const active = new CollaborationClient(transport({
      loadConversation: vi.fn().mockReturnValue(detailPending.promise),
      switchScope: vi.fn().mockReturnValue(scopePending.promise),
    }))
    await active.load()
    const conversationLoad = active.loadConversation('child')
    const scopeSwitch = active.switchScope({ kind: 'personal' })
    active.dispose()
    detailPending.resolve(detail)
    scopePending.resolve(undefined)
    await Promise.all([conversationLoad, scopeSwitch])
    expect(active.getSnapshot().conversations.child?.status).toBe('loading')
    expect(active.getSnapshot().scopeBusy).toBe(true)
  })

  it('suppresses rejected scope, conversation, and visibility requests after disposal', async () => {
    const contextPending = deferred<CollaborationContext>()
    const contextClient = new CollaborationClient(transport({ loadContext: vi.fn().mockReturnValue(contextPending.promise) }))
    const contextRequest = contextClient.load()
    contextClient.dispose()
    contextPending.reject(new Error('offline'))
    await contextRequest
    expect(contextClient.getSnapshot().status).toBe('loading')

    const scopePending = deferred<undefined>()
    const scopeClient = new CollaborationClient(transport({ switchScope: vi.fn().mockReturnValue(scopePending.promise) }))
    await scopeClient.load()
    const scopeRequest = scopeClient.switchScope({ kind: 'personal' })
    scopeClient.dispose()
    scopePending.reject(new Error('offline'))
    await scopeRequest
    expect(scopeClient.getSnapshot().scopeBusy).toBe(true)

    const detailPending = deferred<ConversationDetail>()
    const detailClient = new CollaborationClient(transport({ loadConversation: vi.fn().mockReturnValue(detailPending.promise) }))
    await detailClient.load()
    const detailRequest = detailClient.loadConversation('child')
    detailClient.dispose()
    detailPending.reject(new Error('offline'))
    await detailRequest
    expect(detailClient.getSnapshot().conversations.child?.status).toBe('loading')

    const visibilityPending = deferred<undefined>()
    const visibilityClient = new CollaborationClient(transport({ setVisibility: vi.fn().mockReturnValue(visibilityPending.promise) }))
    await visibilityClient.load()
    await visibilityClient.loadConversation('child')
    const visibilityRequest = visibilityClient.setVisibility('child', 'private')
    visibilityClient.dispose()
    visibilityPending.reject(new Error('offline'))
    await visibilityRequest
    expect(visibilityClient.getSnapshot().conversations.child).toMatchObject({ status: 'ready', saving: true })
  })

  it('ignores visibility settlements after a context refresh removes the conversation cache', async () => {
    const successPending = deferred<undefined>()
    const successClient = new CollaborationClient(transport({
      loadContext: vi.fn().mockResolvedValueOnce(projectContext).mockResolvedValueOnce(personalContext),
      setVisibility: vi.fn().mockReturnValue(successPending.promise),
    }))
    await successClient.load()
    await successClient.loadConversation('child')
    const success = successClient.setVisibility('child', 'private')
    await successClient.load()
    successPending.resolve(undefined)
    await success
    expect(successClient.getSnapshot().conversations).toEqual({})

    const failurePending = deferred<undefined>()
    const failureClient = new CollaborationClient(transport({
      loadContext: vi.fn().mockResolvedValueOnce(projectContext).mockResolvedValueOnce(personalContext),
      setVisibility: vi.fn().mockReturnValue(failurePending.promise),
    }))
    await failureClient.load()
    await failureClient.loadConversation('child')
    const failure = failureClient.setVisibility('child', 'private')
    await failureClient.load()
    failurePending.reject(new Error('offline'))
    await failure
    expect(failureClient.getSnapshot().conversations).toEqual({})
  })

  it('re-reads the account context after a project mutation instead of joining the pending read', async () => {
    const initial = deferred<CollaborationContext>()
    const postMutation = deferred<CollaborationContext>()
    const loadContext = vi.fn()
      .mockImplementationOnce(() => initial.promise)
      .mockImplementationOnce(() => postMutation.promise)
    const createProject = vi.fn(async () => ({ projectId: 11 }))
    const client = new CollaborationClient(transport({ loadContext, createProject }))
    const slow = client.load()
    const created = client.createProject('审计二期')
    // The forced refresh must not join the read issued before the mutation.
    initial.resolve(projectContext)
    postMutation.resolve({
      ...projectContext,
      projects: [...projectContext.projects, { projectId: 11, name: '审计二期', path: '/projects/audit2', mode: 'rw' }],
    })
    await expect(created).resolves.toBe(11)
    await slow
    expect(loadContext).toHaveBeenCalledTimes(2)
    expect(client.getSnapshot().context?.projects).toHaveLength(3)
    expect(client.getSnapshot().contextVerified).toBe(true)

    // A late rejection of the superseded read cannot undo the held context.
    const second = deferred<CollaborationContext>()
    const rejected = deferred<CollaborationContext>()
    const retry = vi.fn()
      .mockImplementationOnce(() => rejected.promise)
      .mockImplementationOnce(() => second.promise)
    const clientRetry = new CollaborationClient(transport({ loadContext: retry, createProject }))
    const stale = clientRetry.load()
    const accepted = clientRetry.createProject('审计二期')
    second.resolve(projectContext)
    rejected.reject(new Error('stale read failed'))
    await expect(accepted).resolves.toBe(11)
    await stale
    expect(clientRetry.getSnapshot()).toMatchObject({ contextVerified: true, context: projectContext })
    client.dispose()
    clientRetry.dispose()
  })

  it('coalesces a subscriber-reentered load onto the same context request', async () => {
    const loadContext = vi.fn(async () => projectContext)
    const client = new CollaborationClient(transport({ loadContext }))
    client.subscribe(() => { if (client.getSnapshot().status === 'loading') void client.load() })
    await client.load()
    expect(loadContext).toHaveBeenCalledOnce()
    client.dispose()
  })

  it('cannot restore account eligibility from an invalidated initial response', async () => {
    const pending = deferred<CollaborationContext>()
    const loadContext = vi.fn()
      .mockImplementationOnce(() => pending.promise)
      .mockResolvedValue(projectContext)
    const client = new CollaborationClient(transport({ loadContext }))
    const first = client.load()
    client.invalidateContext()
    pending.resolve(projectContext)
    await first
    expect(client.getSnapshot().contextVerified).toBe(false)
    expect(client.getSnapshot().context).toBeUndefined()
    const rejected = deferred<CollaborationContext>()
    const retry = vi.fn()
      .mockImplementationOnce(() => rejected.promise)
      .mockResolvedValue(projectContext)
    const failing = new CollaborationClient(transport({ loadContext: retry }))
    const read = failing.load()
    failing.invalidateContext()
    rejected.reject(new Error('stale initial read'))
    await read
    expect(failing.getSnapshot().contextVerified).toBe(false)
    expect(failing.getSnapshot().context).toBeUndefined()
    client.dispose()
    failing.dispose()
  })

  it('publishes nothing when a pending context read settles after dispose', async () => {
    const pending = deferred<CollaborationContext>()
    const loadContext = vi.fn(() => pending.promise)
    const client = new CollaborationClient(transport({ loadContext }))
    const read = client.load()
    client.dispose()
    pending.resolve(projectContext)
    await read
    expect(client.getSnapshot().contextVerified).toBe(false)
    expect(client.getSnapshot().context).toBeUndefined()
  })
})

it('loads sharing in a project pane from a personal page and sends its explicit project', async () => {
  const { clientSessionKey } = await import('@deepseek-ai/dsh-client-runtime/client')
  const key = clientSessionKey({ kind: 'project', projectId: 9 }, 'child' as never)
  const personal = clientSessionKey({ kind: 'personal' }, 'child' as never)
  const api = transport({ loadContext: vi.fn().mockResolvedValue(personalContext) })
  const client = new CollaborationClient(api)
  try {
    await client.load()
    await client.loadConversation(personal)
    expect(api.loadConversation).not.toHaveBeenCalled()
    await client.loadConversation(key)
    expect(api.loadConversation).toHaveBeenCalledWith(key, expect.any(AbortSignal))
    expect(client.getSnapshot().conversations[key]?.status).toBe('ready')
    await client.refresh()
    expect(client.getSnapshot().conversations[key]?.status).toBe('ready')
    const fetcher = vi.fn().mockResolvedValue(Response.json(detail))
    const browser = createBrowserCollaborationTransport({ fetch: fetcher, reload: vi.fn() })
    await browser.loadConversation(key, new AbortController().signal)
    expect(fetcher).toHaveBeenCalledWith('/account/api/conversations/child?projectId=9&dshTarget=project%3A9', expect.any(Object))
    await browser.setVisibility(key, 'private', new AbortController().signal)
    expect(fetcher).toHaveBeenLastCalledWith('/account/api/conversations/child?projectId=9&dshTarget=project%3A9', expect.objectContaining({ method: 'PATCH' }))
    expect(() => browser.loadConversation(personal, new AbortController().signal)).toThrow('no project sharing')
  } finally { client.dispose() }
})
