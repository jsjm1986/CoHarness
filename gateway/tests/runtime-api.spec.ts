import Database from 'better-sqlite3'
import { sessionLogicalFormatCatalog as sessionFormatCatalog } from '@deepseek-ai/dsh-session-format-catalog'
import { generateKeyPairSync } from 'node:crypto'
import type { IncomingHttpHeaders, IncomingMessage, ServerResponse } from 'node:http'
import type { Pool } from 'pg'
import { describe, expect, it, onTestFinished, vi } from 'vitest'
import type { UserRow } from '../src/auth.ts'
import { CollaborationDeniedError } from '../src/collaboration.ts'
import {
  type ConversationEvent,
  type ConversationHeader,
  ConversationReadError,
  encodePageCursor,
  type StoredConversation,
} from '../src/postgres/conversation-repository.ts'
import { GatewayPrincipalSigner, PRINCIPAL_HEADER } from '../src/principal.ts'
import { DesktopCoordinator, SqliteDesktopCoordinatorRepository } from '../src/desktop-coordinator.ts'
import type { DocumentTransferResponse } from '../src/document-transfer.ts'
import { createRuntimeApiHandler } from '../src/runtime-api.ts'

const ORGANIZATION_ID = '11d4a86c-4624-44fa-b69f-7e3f48cc5a04'
const ORGANIZATION_SLUG = 'acme'
const PROJECT_ID = 23
const PROJECT_INTERNAL_ID = '38131c5c-a84f-43ac-9487-24e90889273f'
const CREATOR_ID = 7
const CREATOR_INTERNAL_ID = 'c21c9696-6ca4-4698-84b8-3755e766e65d'
const MEMBER_ID = 8
const ADMIN_ID = 9
const ADMIN_INTERNAL_ID = '9d264f72-1c11-479d-ae39-0b0429d70d91'
const GENERATION = 4
const RUNTIME_TOKEN = 'runtime-token'
const CREATED_AT = 1_786_698_000_000

type RuntimeHandler = ReturnType<typeof createRuntimeApiHandler>
type RuntimeDependencies = Parameters<typeof createRuntimeApiHandler>[0]

interface RuntimeResponse {
  handled: boolean
  status: number
  body: unknown
}

const event: ConversationEvent = {
  type: 'user/message',
  seq: 0,
  time: CREATED_AT,
  data: { content: [{ type: 'text', text: 'hello' }] },
  surfaceOp: 'append',
}

function user(id: number, role: UserRow['role'] = 'user'): UserRow {
  return {
    id,
    username: `user-${String(id)}`,
    displayName: `User ${String(id)}`,
    role,
    status: 'active',
    homePath: `/tmp/user-${String(id)}`,
    mustChangePassword: false,
    autoReviewEligible: false,
  }
}

async function request(
  handler: RuntimeHandler,
  pathname: string,
  input: { body: unknown; principal?: string; token?: string; method?: string },
): Promise<RuntimeResponse> {
  const headers: IncomingHttpHeaders = {
    authorization: `Bearer ${input.token ?? RUNTIME_TOKEN}`,
    'content-type': 'application/json',
  }
  if (input.principal !== undefined) headers[PRINCIPAL_HEADER] = input.principal
  const req = {
    method: input.method ?? 'POST',
    url: pathname,
    headers,
  } as unknown as IncomingMessage
  let status = 0
  let responseBody = ''
  const res = {
    writeHead(nextStatus: number) {
      status = nextStatus
      return this
    },
    end(chunk?: string | Buffer) {
      if (chunk !== undefined) responseBody += Buffer.isBuffer(chunk) ? chunk.toString() : chunk
      return this
    },
  } as unknown as ServerResponse
  const routePath = pathname.split('?', 1)[0] ?? pathname
  const handled = await handler(req, res, routePath, JSON.stringify(input.body))
  return {
    handled,
    status,
    body: responseBody === '' ? undefined : JSON.parse(responseBody),
  }
}

function fixture() {
  const { privateKey } = generateKeyPairSync('ed25519')
  const principals = new GatewayPrincipalSigner(privateKey, ORGANIZATION_SLUG, 60_000)
  const modes = new Map<number, 'ro' | 'rw'>([
    [CREATOR_ID, 'rw'],
    [MEMBER_ID, 'rw'],
  ])
  const query = vi.fn(async (_text: string, values?: unknown[]) => ({
    rows: values?.[1] === CREATOR_ID ? [{ id: CREATOR_INTERNAL_ID }]
      : values?.[1] === ADMIN_ID ? [{ id: ADMIN_INTERNAL_ID }] : [],
  }))
  const append = vi.fn(async (
    _sessionId: string,
    _batchId: string,
    _events: readonly ConversationEvent[],
    _header?: ConversationHeader,
  ): Promise<'inserted' | 'duplicate'> => 'inserted')
  const load = vi.fn(async (_sessionId: string): Promise<StoredConversation | undefined> => undefined)
  const resolveOrganizationCredential = vi.fn(async (_subject, ref: string) =>
    ref === 'DSH_ORG_PRIMARY_API_KEY' ? 'sk-organization' : null)
  const push = {
    notifyCompleted: vi.fn(async (_sessionId: string, _eventSeq: number): Promise<void> => {}),
  }
  const archiveSnapshot = vi.fn(async () => [{ id: 'command-1', rootSessionId: 'session-archive', action: 'restore' as const }])
  const archiveAck = vi.fn(async () => {})
  const deps = {
    context: {
      organizationSlug: ORGANIZATION_SLUG,
      nodeId: '00000000-0000-4000-8000-000000000099',
      pool: { query } as unknown as Pool,
    },
    instances: {
      authenticateRuntimeToken: vi.fn(async (token: string) => token === RUNTIME_TOKEN ? {
        organizationId: ORGANIZATION_ID,
        target: { kind: 'project' as const, id: PROJECT_ID },
        generation: GENERATION,
        projectInternalId: PROJECT_INTERNAL_ID,
      } : null),
    },
    conversations: {
      append,
      listScoped: vi.fn(async () => []),
      load,
      removeTree: vi.fn(async () => []),
    },
    collaboration: {
      access: vi.fn(async () => { throw new CollaborationDeniedError('conversation-not-found') }),
      claimInteraction: vi.fn(async () => false),
      projectForUser: vi.fn(async (projectId: number, userId: number) => {
        const administrator = userId === ADMIN_ID
        const mode = administrator ? 'rw' : modes.get(userId)
        return projectId === PROJECT_ID && mode !== undefined
          ? { projectId, name: 'Shared', path: '/tmp/shared', mode, administrator }
          : null
      }),
      readableSessionIds: vi.fn(async () => []),
    },
    principals,
    governance: { resolveOrganizationCredential },
    push,
    archives: { syncRuntimeSnapshot: archiveSnapshot, acknowledgeCommand: archiveAck },
  } satisfies RuntimeDependencies
  const issuePrincipal = (userId: number, mode: 'ro' | 'rw' = modes.get(userId) ?? 'rw') => principals.issue({
    user: user(userId, userId === ADMIN_ID ? 'admin' : 'user'),
    scope: {
      kind: 'project',
      projectId: PROJECT_ID,
      projectName: 'Shared',
      mode,
    },
    runtime: { kind: 'project', id: PROJECT_ID, generation: GENERATION },
  })
  return {
    append,
    query,
    deps,
    handler: createRuntimeApiHandler(deps),
    issuePrincipal,
    modes,
    principals,
    resolveOrganizationCredential,
    push,
    archiveSnapshot,
    archiveAck,
  }
}

describe('profile management authorization', () => {
  it('admits an active administrator and rechecks a later revocation', async () => {
    const runtime = fixture()
    const principal = runtime.issuePrincipal(ADMIN_ID)
    const path = '/internal/runtime/plugin-management/authorize'
    expect(await request(runtime.handler, path, { body: {}, principal })).toMatchObject({ status: 204 })
    expect(runtime.query).toHaveBeenLastCalledWith(expect.stringContaining("m.role='admin'"), [ORGANIZATION_ID, ADMIN_ID])
    runtime.query.mockResolvedValueOnce({ rows: [] })
    expect(await request(runtime.handler, path, { body: {}, principal })).toMatchObject({ status: 403 })
  })

  it('admits only the profile purpose at the profile authority endpoint', async () => {
    const runtime = fixture()
    const issue = (purpose: 'plugin-admin' | 'terminal-admin') => runtime.principals.issue({
      user: user(ADMIN_ID, 'admin'), purpose,
      scope: { kind: 'project', projectId: PROJECT_ID, projectName: 'Shared', mode: 'ro' },
      runtime: { kind: 'project', id: PROJECT_ID, generation: GENERATION },
    })
    const path = '/internal/runtime/plugin-management/authorize'
    expect(await request(runtime.handler, path, { body: {}, principal: issue('plugin-admin') })).toMatchObject({ status: 204 })
    expect(await request(runtime.handler, path, { body: {}, principal: issue('terminal-admin') })).toMatchObject({ status: 403 })
    expect(await request(runtime.handler, '/internal/runtime/terminal-management/authorize', { body: {}, principal: issue('plugin-admin') })).toMatchObject({ status: 403 })
    runtime.query.mockResolvedValueOnce({ rows: [] })
    expect(await request(runtime.handler, path, { body: {}, principal: issue('plugin-admin') })).toMatchObject({ status: 403 })
  })

  it('rejects a member or a missing principal before looking up deployment authority', async () => {
    const runtime = fixture()
    const path = '/internal/runtime/plugin-management/authorize'
    expect(await request(runtime.handler, path, { body: {}, principal: runtime.issuePrincipal(CREATOR_ID) }))
      .toMatchObject({ status: 403 })
    expect(await request(runtime.handler, path, { body: {} })).toMatchObject({ status: 403 })
    expect(runtime.query).not.toHaveBeenCalled()
  })
})

async function prepare(
  runtime: ReturnType<typeof fixture>,
  sessionId: string,
  visibility: 'project' | 'private',
  creatorUserId = CREATOR_ID,
): Promise<string> {
  const response = await request(runtime.handler, '/internal/runtime/session/create', {
    principal: runtime.issuePrincipal(creatorUserId),
    body: {
      visibility,
      header: { id: sessionId, version: 0, createdAt: CREATED_AT, cwd: '/tmp/shared' },
    },
  })
  expect(response).toMatchObject({ handled: true, status: 200 })
  return (response.body as { authorization: string }).authorization
}

async function appendFirst(
  runtime: ReturnType<typeof fixture>,
  sessionId: string,
  authorization: string,
): Promise<RuntimeResponse> {
  return request(runtime.handler, '/internal/runtime/session/append', {
    body: {
      sessionId,
      batchId: `batch-${sessionId}`,
      creationAuthorization: authorization,
      events: [event],
    },
  })
}

describe('runtime session creation authorization', () => {
  it('materializes a project root signed for the organization slug', async () => {
    const runtime = fixture()
    const authorization = await prepare(runtime, 'session-root', 'private')
    expect(runtime.principals.verifySessionCreation(authorization)).toMatchObject({
      organization: ORGANIZATION_SLUG,
      creatorUserId: CREATOR_ID,
      runtime: { kind: 'project', id: PROJECT_ID, generation: GENERATION },
      header: { id: 'session-root', version: 0, createdAt: CREATED_AT, cwd: '/tmp/shared' },
      visibility: 'private',
    })

    expect(await appendFirst(runtime, 'session-root', authorization)).toMatchObject({
      handled: true,
      status: 200,
      body: { result: 'inserted' },
    })
    expect(runtime.append).toHaveBeenCalledWith(
      'session-root',
      'batch-session-root',
      [event],
      {
        id: 'session-root',
        organizationId: ORGANIZATION_ID,
        creatorUserId: CREATOR_INTERNAL_ID,
        projectId: PROJECT_INTERNAL_ID,
        visibility: 'private',
        sessionFormatVersion: 0,
        createdAt: CREATED_AT,
        cwd: '/tmp/shared',
      },
    )
  })

  it.each([
    ['removed', undefined],
    ['downgraded', 'ro' as const],
  ])('rechecks a creator who was %s before the first append', async (_label, mode) => {
    const runtime = fixture()
    const authorization = await prepare(runtime, 'revoked-root', 'project')
    if (mode === undefined) runtime.modes.delete(CREATOR_ID)
    else runtime.modes.set(CREATOR_ID, mode)
    runtime.append.mockClear()

    expect(await appendFirst(runtime, 'revoked-root', authorization)).toMatchObject({
      handled: true,
      status: 403,
      body: { error: 'forbidden' },
    })
    expect(runtime.append).not.toHaveBeenCalled()
  })

  it.each([
    ['runtime id', { runtime: { kind: 'project' as const, id: PROJECT_ID + 1, generation: GENERATION }, sessionId: 'bound-root' }],
    ['runtime generation', { runtime: { kind: 'project' as const, id: PROJECT_ID, generation: GENERATION + 1 }, sessionId: 'bound-root' }],
    ['session id', { runtime: { kind: 'project' as const, id: PROJECT_ID, generation: GENERATION }, sessionId: 'other-root' }],
  ])('rejects an authorization bound to another %s', async (_label, binding) => {
    const runtime = fixture()
    const authorization = runtime.principals.issueSessionCreation({
      creatorUserId: CREATOR_ID,
      runtime: binding.runtime,
      header: { id: binding.sessionId, version: 0, createdAt: CREATED_AT },
      visibility: 'project',
    })

    expect(await appendFirst(runtime, 'bound-root', authorization)).toMatchObject({
      handled: true,
      status: 400,
      body: { error: 'invalid session creation authorization' },
    })
    expect(runtime.append).not.toHaveBeenCalled()
  })

  it('applies project and private ACLs before a blank root is materialized', async () => {
    const runtime = fixture()
    const projectAuthorization = await prepare(runtime, 'blank-project', 'project')
    const privateAuthorization = await prepare(runtime, 'blank-private', 'private')

    const readable = await request(runtime.handler, '/internal/runtime/collaboration/readable', {
      principal: runtime.issuePrincipal(MEMBER_ID),
      body: {
        sessionIds: ['blank-project', 'blank-private'],
        creationAuthorizations: [
          { sessionId: 'blank-project', authorization: projectAuthorization },
          { sessionId: 'blank-private', authorization: privateAuthorization },
        ],
      },
    })
    expect(readable).toMatchObject({
      handled: true,
      status: 200,
      body: { sessionIds: ['blank-project'] },
    })

    const creatorPrivate = await request(runtime.handler, '/internal/runtime/collaboration/authorize', {
      principal: runtime.issuePrincipal(CREATOR_ID),
      body: {
        sessionId: 'blank-private',
        action: 'write',
        creationAuthorization: privateAuthorization,
      },
    })
    expect(creatorPrivate).toMatchObject({
      handled: true,
      status: 200,
      body: { access: { visibility: 'private', canRead: true, canWrite: true, canManage: true } },
    })

    const administratorReadable = await request(runtime.handler, '/internal/runtime/collaboration/readable', {
      principal: runtime.issuePrincipal(ADMIN_ID),
      body: {
        sessionIds: ['blank-project', 'blank-private'],
        creationAuthorizations: [
          { sessionId: 'blank-project', authorization: projectAuthorization },
          { sessionId: 'blank-private', authorization: privateAuthorization },
        ],
      },
    })
    expect(administratorReadable).toMatchObject({
      handled: true,
      status: 200,
      body: { sessionIds: ['blank-project', 'blank-private'] },
    })

    const administratorPrivate = await request(runtime.handler, '/internal/runtime/collaboration/authorize', {
      principal: runtime.issuePrincipal(ADMIN_ID),
      body: {
        sessionId: 'blank-private',
        action: 'manage',
        creationAuthorization: privateAuthorization,
      },
    })
    expect(administratorPrivate).toMatchObject({
      handled: true,
      status: 200,
      body: { access: { mode: 'rw', canRead: true, canWrite: true, canManage: true } },
    })
  })

  it('allows an administrator without project membership to materialize a private root', async () => {
    const runtime = fixture()
    const authorization = await prepare(runtime, 'administrator-root', 'private', ADMIN_ID)

    expect(await appendFirst(runtime, 'administrator-root', authorization)).toMatchObject({
      handled: true,
      status: 200,
      body: { result: 'inserted' },
    })
    expect(runtime.append).toHaveBeenCalledWith(
      'administrator-root',
      'batch-administrator-root',
      [event],
      expect.objectContaining({
        creatorUserId: ADMIN_INTERNAL_ID,
        visibility: 'private',
      }),
    )
  })

  it('rejects a project root appended through an ordinary header', async () => {
    const runtime = fixture()
    const response = await request(runtime.handler, '/internal/runtime/session/append', {
      principal: runtime.issuePrincipal(CREATOR_ID),
      body: {
        sessionId: 'header-root',
        batchId: 'batch-header-root',
        header: { id: 'header-root', version: 0, createdAt: CREATED_AT },
        visibility: 'project',
        events: [event],
      },
    })
    expect(response).toMatchObject({
      handled: true,
      status: 403,
      body: { error: 'forbidden' },
    })
    expect(runtime.append).not.toHaveBeenCalled()
  })
})

describe('runtime document transfer authorization', () => {
  it('requires the current principal and delegates only validated runtime metadata', async () => {
    const runtime = fixture()
    const transfer = vi.fn(async (input: { payload: unknown }): Promise<DocumentTransferResponse> => {
      // The callback only records that the validated payload reached it.
      void input
      return {
        version: 1,
        transferId: 'transfer-1',
        source: { kind: 'personal', label: 'Personal documents' },
        target: { kind: 'project', label: 'Shared' },
        items: [],
      }
    })
    const dependencies = runtime.deps as RuntimeDependencies
    dependencies.documentTransfer = transfer
    const noPrincipal = await request(runtime.handler, '/internal/runtime/documents/transfer', {
      body: { version: 1 },
    })
    expect(noPrincipal).toMatchObject({ handled: true, status: 403 })
    const accepted = await request(runtime.handler, '/internal/runtime/documents/transfer', {
      principal: runtime.issuePrincipal(CREATOR_ID),
      body: {
        version: 1,
        source: { kind: 'project', projectId: PROJECT_ID },
        target: { kind: 'personal' },
        documents: [{ docId: 'report.txt' }],
      },
    })
    expect(accepted).toMatchObject({ handled: true, status: 200, body: { transferId: 'transfer-1' } })
    expect(transfer).toHaveBeenCalledWith(expect.objectContaining({
      payload: expect.objectContaining({ version: 1 }),
    }))

    const list = vi.fn(async () => ({
      version: 1 as const,
      scope: { kind: 'project' as const, label: 'Shared' },
      documents: [],
    }))
    dependencies.documentTransferList = list
    const listed = await request(runtime.handler, '/internal/runtime/documents/transfer/list', {
      principal: runtime.issuePrincipal(CREATOR_ID),
      body: { version: 1, scope: { kind: 'project', projectId: PROJECT_ID } },
    })
    expect(listed).toMatchObject({ handled: true, status: 200, body: { scope: { label: 'Shared' } } })
    expect(list).toHaveBeenCalledOnce()
  })
})

describe('runtime completed-turn push notifications', () => {
  it('notifies only after an inserted completed turn/end event', async () => {
    const runtime = fixture()
    const sessionId = 'push-completed'
    const authorization = await prepare(runtime, sessionId, 'project')
    const completed: ConversationEvent = {
      type: 'turn/end',
      seq: 9,
      time: CREATED_AT + 9,
      data: { turn: 1, reason: { kind: 'completed' } },
    }

    const response = await request(runtime.handler, '/internal/runtime/session/append', {
      body: {
        sessionId,
        batchId: `batch-${sessionId}`,
        creationAuthorization: authorization,
        events: [completed],
      },
    })

    expect(response).toMatchObject({ handled: true, status: 200, body: { result: 'inserted' } })
    expect(runtime.push.notifyCompleted).toHaveBeenCalledOnce()
    expect(runtime.push.notifyCompleted).toHaveBeenCalledWith(sessionId, 9)
  })

  it('does not notify duplicate appends or non-completed turn endings', async () => {
    const runtime = fixture()
    const sessionId = 'push-filtered'
    const authorization = await prepare(runtime, sessionId, 'project')
    const ended: ConversationEvent = {
      type: 'turn/end',
      seq: 10,
      time: CREATED_AT + 10,
      data: { turn: 1, reason: { kind: 'aborted' } },
    }
    runtime.append.mockResolvedValueOnce('duplicate')

    const duplicate = await request(runtime.handler, '/internal/runtime/session/append', {
      body: {
        sessionId,
        batchId: `duplicate-${sessionId}`,
        creationAuthorization: authorization,
        events: [{ ...ended, seq: 10 }],
      },
    })
    const nonCompleted = await request(runtime.handler, '/internal/runtime/session/append', {
      body: {
        sessionId,
        batchId: `aborted-${sessionId}`,
        creationAuthorization: authorization,
        events: [ended],
      },
    })

    expect(duplicate).toMatchObject({ body: { result: 'duplicate' } })
    expect(nonCompleted).toMatchObject({ body: { result: 'inserted' } })
    expect(runtime.push.notifyCompleted).not.toHaveBeenCalled()
  })
})

describe('runtime bounded session history', () => {
  it('authorizes from metadata and serves an indexed page without loading the log', async () => {
    const runtime = fixture()
    const header: ConversationHeader = {
      id: 'paged-session',
      organizationId: ORGANIZATION_ID,
      creatorUserId: CREATOR_INTERNAL_ID,
      projectId: PROJECT_INTERNAL_ID,
      rootSessionId: 'paged-session',
      visibility: 'project',
      sessionFormatVersion: 0,
      createdAt: CREATED_AT,
      cwd: '/tmp/shared',
    }
    const readHeader = vi.fn(async () => header)
    const revision = vi.fn(async () => '7:2')
    const readPage = vi.fn(async () => ({
      header,
      events: [event],
      revision: '7:2',
      startSeq: 0,
      endSeq: 0,
      hasMore: false,
      uncompressedBytes: 128,
    }))
    const conversations = runtime.deps.conversations as typeof runtime.deps.conversations & {
      readHeader: typeof readHeader
      revision: typeof revision
      readPage: typeof readPage
    }
    conversations.readHeader = readHeader
    conversations.revision = revision
    conversations.readPage = readPage

    const response = await request(runtime.handler, '/internal/runtime/session/page?sessionId=paged-session', {
      method: 'GET', body: {},
    })
    expect(response).toMatchObject({
      handled: true,
      status: 200,
      body: { header: { id: 'paged-session' }, events: [event], hasMore: false, uncompressedBytes: 128 },
    })
    expect(response.body).toMatchObject({ revision: `postgres:${ORGANIZATION_ID}:project:${String(PROJECT_ID)}:7:2` })
    expect(readHeader).toHaveBeenCalledOnce()
    expect(readPage).toHaveBeenCalledOnce()
    expect(runtime.deps.conversations.load).not.toHaveBeenCalled()
  })

  it('maps malformed page query values to a protocol response', async () => {
    const runtime = fixture()
    const response = await request(runtime.handler, '/internal/runtime/session/page?sessionId=x&maxBytes=not-a-number', {
      method: 'GET', body: {},
    })
    expect(response).toMatchObject({
      handled: true,
      status: 400,
      body: { error: 'conversation-protocol', code: 'protocol' },
    })
  })

  it('reports a moved revision under a compatibility page cursor as a retryable dependency failure', async () => {
    const runtime = fixture()
    const header: ConversationHeader = {
      id: 'fallback-session',
      organizationId: ORGANIZATION_ID,
      creatorUserId: CREATOR_INTERNAL_ID,
      projectId: PROJECT_INTERNAL_ID,
      rootSessionId: 'fallback-session',
      visibility: 'project',
      sessionFormatVersion: 0,
      createdAt: CREATED_AT,
      cwd: '/tmp/shared',
    }
    runtime.deps.conversations.load.mockResolvedValue({ header, events: [event], revision: '7:2' })
    const page = (cursor: string) => request(
      runtime.handler,
      `/internal/runtime/session/page?sessionId=fallback-session&cursor=${encodeURIComponent(cursor)}`,
      { method: 'GET', body: {} },
    )

    const moved = await page(encodePageCursor({ version: 1, sessionId: 'fallback-session', revision: '7:1', direction: 'older', anchor: 1 }))
    expect(moved).toMatchObject({ status: 503, body: { error: 'conversation-dependency', code: 'dependency' } })
    const foreign = await page(encodePageCursor({ version: 1, sessionId: 'other-session', revision: '7:2', direction: 'older', anchor: 1 }))
    expect(foreign).toMatchObject({ status: 400, body: { error: 'conversation-protocol', code: 'protocol' } })
  })

  it('serves the lightweight history index from the repository without invoking load()', async () => {
    const runtime = fixture()
    const header: ConversationHeader = {
      id: 'indexed-session',
      organizationId: ORGANIZATION_ID,
      creatorUserId: CREATOR_INTERNAL_ID,
      projectId: PROJECT_INTERNAL_ID,
      rootSessionId: 'indexed-session',
      visibility: 'project',
      sessionFormatVersion: 0,
      createdAt: CREATED_AT,
      cwd: '/tmp/shared',
    }
    const readHeader = vi.fn(async () => header)
    const readHistoryIndex = vi.fn(async () => ({
      revision: '8:12',
      asOfSeq: 11,
      totalTurns: 2,
      items: [
        { turn: 1, startSeq: 0, endSeq: 5, prompt: 'one' },
        { turn: 2, startSeq: 6, endSeq: 11, response: 'two' },
      ],
      truncated: false,
    }))
    const conversations = runtime.deps.conversations as typeof runtime.deps.conversations & {
      readHeader: typeof readHeader
      readHistoryIndex: typeof readHistoryIndex
    }
    conversations.readHeader = readHeader
    conversations.readHistoryIndex = readHistoryIndex

    const response = await request(runtime.handler, '/internal/runtime/session/index?sessionId=indexed-session', {
      method: 'GET', body: {},
    })
    expect(response).toMatchObject({
      handled: true,
      status: 200,
      body: {
        header: { id: 'indexed-session' },
        asOfSeq: 11,
        totalTurns: 2,
        items: [{ turn: 1, startSeq: 0, endSeq: 5 }, { turn: 2, startSeq: 6, endSeq: 11 }],
      },
    })
    expect(readHeader).toHaveBeenCalledOnce()
    expect(readHistoryIndex).toHaveBeenCalledOnce()
    expect(runtime.deps.conversations.load).not.toHaveBeenCalled()
  })

  it('rejects an invalid history index item before sending it to the runtime', async () => {
    const runtime = fixture()
    const header: ConversationHeader = {
      id: 'invalid-indexed-session',
      organizationId: ORGANIZATION_ID,
      creatorUserId: CREATOR_INTERNAL_ID,
      projectId: PROJECT_INTERNAL_ID,
      rootSessionId: 'invalid-indexed-session',
      visibility: 'project',
      sessionFormatVersion: 0,
      createdAt: CREATED_AT,
      cwd: '/tmp/shared',
    }
    const conversations = runtime.deps.conversations as typeof runtime.deps.conversations & {
      readHeader: () => Promise<ConversationHeader>
      readHistoryIndex: () => Promise<{
        revision: string
        asOfSeq: number
        totalTurns: number
        items: { turn: number; startSeq: number; endSeq: number }[]
        truncated: boolean
      }>
    }
    conversations.readHeader = async () => header
    conversations.readHistoryIndex = async () => ({
      revision: '1:2', asOfSeq: 1, totalTurns: 1,
      items: [{ turn: 1, startSeq: 2, endSeq: 1 }], truncated: false,
    })
    const response = await request(runtime.handler, '/internal/runtime/session/index?sessionId=invalid-indexed-session', {
      method: 'GET', body: {},
    })
    expect(response).toMatchObject({ status: 400, body: { error: 'conversation-protocol', code: 'protocol' } })
  })
})

describe('runtime organization credentials', () => {
  it('resolves one allowed reference through the authenticated runtime subject without a browser principal', async () => {
    const runtime = fixture()
    const response = await request(runtime.handler, '/internal/runtime/model-credential', {
      body: { ref: 'DSH_ORG_PRIMARY_API_KEY' },
    })

    expect(response).toMatchObject({
      handled: true,
      status: 200,
      body: { configured: true, value: 'sk-organization' },
    })
    expect(runtime.resolveOrganizationCredential).toHaveBeenCalledWith(
      { kind: 'project', id: PROJECT_ID },
      'DSH_ORG_PRIMARY_API_KEY',
    )
  })

  it('reports an unavailable reference without exposing another credential', async () => {
    const runtime = fixture()
    expect(await request(runtime.handler, '/internal/runtime/model-credential', {
      body: { ref: 'DSH_ORG_MISSING_API_KEY' },
    })).toMatchObject({ handled: true, status: 200, body: { configured: false } })
    expect(await request(runtime.handler, '/internal/runtime/model-credential', {
      body: { ref: '../secret' },
    })).toMatchObject({ handled: true, status: 400 })
  })

  it('preserves the governance service receiver for managed credentials', async () => {
    const runtime = fixture()
    const governance = {
      marker: 'project-secret-test',
      async resolveManagedCredential(this: { marker: string }, _subject: unknown, ref: string): Promise<string | null> {
        return ref === 'DSH_PROJECT_PRIMARY_API_KEY' ? this.marker : null
      },
      async resolveOrganizationCredential(_subject: unknown, _ref: string): Promise<string | null> {
        return null
      },
    }
    const handler = createRuntimeApiHandler({
      ...runtime.deps,
      governance,
    } as RuntimeDependencies)

    await expect(request(handler, '/internal/runtime/model-credential', {
      body: { ref: 'DSH_PROJECT_PRIMARY_API_KEY' },
    })).resolves.toMatchObject({
      handled: true,
      status: 200,
      body: { configured: true, value: 'project-secret-test' },
    })
  })
})

describe('runtime archive synchronization', () => {
  it('accepts a bounded projection batch and returns pending lifecycle commands', async () => {
    const runtime = fixture()
    const response = await request(runtime.handler, '/internal/runtime/archive/snapshot', {
      body: {
        revision: 4,
        archivedSessionIds: ['session-archive'],
        sessions: [{
          sessionId: 'session-archive', header: { createdAt: CREATED_AT, cwd: '/tmp/shared' },
          messageCount: 1, rootMessageCount: 3,
        }],
        search: [{ sessionId: 'session-archive', seq: 0, role: 'user', content: 'hello', occurredAt: CREATED_AT }],
      },
    })
    expect(response).toMatchObject({ handled: true, status: 200, body: { commands: [{ id: 'command-1', rootSessionId: 'session-archive', action: 'restore' }] } })
    expect(runtime.archiveSnapshot).toHaveBeenCalledWith(expect.objectContaining({
      runtime: { kind: 'project', id: PROJECT_ID }, revision: 4, archivedSessionIds: ['session-archive'],
      sessions: [expect.objectContaining({ messageCount: 1, rootMessageCount: 3 })],
    }), { kind: 'project', id: PROJECT_ID })

    const ack = await request(runtime.handler, '/internal/runtime/archive/ack', {
      body: { commandId: 'command-1', revision: 5 },
    })
    expect(ack).toMatchObject({ handled: true, status: 200, body: { acknowledged: true } })
    expect(runtime.archiveAck).toHaveBeenCalledWith('command-1', 5, undefined, { kind: 'project', id: PROJECT_ID })
  })

  it('rejects malformed retained Workspace metadata at the runtime boundary', async () => {
    const runtime = fixture()
    const response = await request(runtime.handler, '/internal/runtime/archive/snapshot', {
      body: {
        revision: 1,
        archivedSessionIds: ['session-archive'],
        sessions: [{
          sessionId: 'session-archive',
          header: {},
          workspace: { path: 7, title: 'Workspace', position: 0 },
        }],
      },
    })
    expect(response).toMatchObject({ handled: true, status: 400, body: { error: 'invalid archive session snapshot' } })
    expect(runtime.archiveSnapshot).not.toHaveBeenCalled()
  })

  it('rejects an invalid root message aggregate', async () => {
    const runtime = fixture()
    const response = await request(runtime.handler, '/internal/runtime/archive/snapshot', {
      body: {
        revision: 1,
        archivedSessionIds: ['session-archive'],
        sessions: [{ sessionId: 'session-archive', header: {}, rootMessageCount: -1 }],
      },
    })
    expect(response).toMatchObject({ handled: true, status: 400, body: { error: 'invalid archive session snapshot' } })
    expect(runtime.archiveSnapshot).not.toHaveBeenCalled()
  })
})

describe('runtime session event validation', () => {
  it.each([
    ['missing data', { type: 'user/message', seq: 0, time: CREATED_AT, surfaceOp: 'append' }],
    ['missing surface operation', { type: 'user/message', seq: 0, time: CREATED_AT, data: {} }],
    ['malformed replacement', {
      type: 'assistant/message',
      seq: 0,
      time: CREATED_AT,
      data: {},
      surfaceOp: { op: 'replace', start: 0, end: 0, extra: true },
    }],
    ['surface metadata on a log event', {
      type: 'turn/start',
      seq: 0,
      time: CREATED_AT,
      data: {},
      surfaceOp: 'append',
    }],
    ['source metadata on a log event', {
      type: 'turn/start',
      seq: 0,
      time: CREATED_AT,
      data: {},
      sourceEventSeqs: [0],
    }],
    ['an extra envelope field', { ...event, extra: true }],
  ])('rejects %s', async (_label, invalidEvent) => {
    const runtime = fixture()
    const authorization = await prepare(runtime, `invalid-${_label.replaceAll(' ', '-')}`, 'project')

    const response = await request(runtime.handler, '/internal/runtime/session/append', {
      body: {
        sessionId: `invalid-${_label.replaceAll(' ', '-')}`,
        batchId: `batch-invalid-${_label.replaceAll(' ', '-')}`,
        creationAuthorization: authorization,
        events: [invalidEvent],
      },
    })

    expect(response).toMatchObject({
      handled: true,
      status: 400,
      body: { error: 'invalid conversation event batch' },
    })
    expect(runtime.append).not.toHaveBeenCalled()
  })

  it.each([
    ['a system message carrying its required surface marker', {
      type: 'system/message',
      seq: 0,
      time: CREATED_AT,
      data: {
        message: {
          id: 'message-1',
          role: 'system',
          content: [{ type: 'text', text: 'system prompt' }],
        },
        source: { kind: 'plugin', plugin: 'dsh-system-prompt' },
      },
      surfaceOp: 'append',
    }],
    ['a canonical positional replacement', {
      type: 'user/message',
      seq: 3,
      time: CREATED_AT,
      data: {},
      surfaceOp: { op: 'replace', startSeq: 1, endSeq: 2 },
      sourceEventSeqs: [1, 2],
    }],
    ['a pre-rename positional replacement', {
      type: 'user/message',
      seq: 3,
      time: CREATED_AT,
      data: {},
      surfaceOp: { op: 'replace', start: 1, end: 2 },
      sourceEventSeqs: [1, 2],
    }],
    ['an ignorable record keeping opaque surface metadata', {
      type: 'future/event',
      seq: 0,
      time: CREATED_AT,
      data: {},
      surfaceOp: 'append',
      sourceEventSeqs: [0],
      ignorable: true,
    }],
  ])('accepts %s', async (_label, validEvent) => {
    const runtime = fixture()
    const sessionId = `valid-${_label.replaceAll(' ', '-')}`
    const authorization = await prepare(runtime, sessionId, 'project')

    const response = await request(runtime.handler, '/internal/runtime/session/append', {
      body: {
        sessionId,
        batchId: `batch-${sessionId}`,
        creationAuthorization: authorization,
        events: [validEvent],
      },
    })

    expect(response).toMatchObject({ handled: true, status: 200, body: { result: 'inserted' } })
    expect(runtime.append).toHaveBeenCalledWith(sessionId, `batch-${sessionId}`, [validEvent], expect.anything())
  })
})

describe('runtime session body migration', () => {
  const legacyHeader: ConversationHeader = {
    id: 'session-legacy',
    organizationId: ORGANIZATION_ID,
    creatorUserId: CREATOR_INTERNAL_ID,
    projectId: PROJECT_INTERNAL_ID,
    rootSessionId: 'session-legacy',
    visibility: 'project',
    sessionFormatVersion: 0,
    createdAt: CREATED_AT,
    cwd: '/tmp/shared',
  }
  const wireRevision = `postgres:${ORGANIZATION_ID}:project:${PROJECT_ID}:7:40`

  type MigrateCall = {
    readHeader?: (sessionId: string) => Promise<ConversationHeader | undefined>
    migrate?: (
      sessionId: string,
      migrationId: string,
      sourceRevision: string,
      targetFormatVersion: number,
      migrate: (header: ConversationHeader, events: ConversationEvent[]) => {
        sessionFormatVersion: number
        seedLength: number | null
        events: ConversationEvent[]
      },
    ) => Promise<{ status: 'committed' | 'current'; revision: string; nextSeq: number; seedLength: number | null }>
  }

  function migrateBody(runtime: ReturnType<typeof fixture>, migrate?: MigrateCall['migrate']) {
    const conversations = runtime.deps.conversations as typeof runtime.deps.conversations & MigrateCall
    conversations.readHeader = vi.fn(async () => legacyHeader)
    conversations.migrate = migrate ?? vi.fn(async () => ({
      status: 'committed' as const,
      revision: '8:42',
      nextSeq: 42,
      seedLength: null,
    }))
    return conversations
  }

  function migrateRequest(runtime: ReturnType<typeof fixture>, overrides: Record<string, unknown> = {}) {
    return request(runtime.handler, '/internal/runtime/session/migrate', {
      body: {
        sessionId: 'session-legacy',
        sourceRevision: wireRevision,
        migrationId: 'migration-1',
        targetHeader: { id: 'session-legacy', version: sessionFormatCatalog.currentVersion, createdAt: CREATED_AT },
        ...overrides,
      },
    })
  }

  it('is absent when the repository cannot migrate bodies', async () => {
    const runtime = fixture()
    const response = await migrateRequest(runtime)
    expect(response).toMatchObject({ handled: false })
  })

  it('migrates under the caller-scoped source revision', async () => {
    const runtime = fixture()
    const conversations = migrateBody(runtime)
    const response = await migrateRequest(runtime)
    expect(response).toMatchObject({
      handled: true,
      status: 200,
      body: {
        result: 'committed',
        revision: `postgres:${ORGANIZATION_ID}:project:${PROJECT_ID}:8:42`,
        nextSeq: 42,
        seedLength: null,
      },
    })
    expect(conversations.migrate).toHaveBeenCalledWith(
      'session-legacy', 'migration-1', '7:40', sessionFormatCatalog.currentVersion, expect.any(Function),
    )
  })

  it('recomputes a v0 body through the Session format catalog', async () => {
    const runtime = fixture()
    let transform: Parameters<NonNullable<MigrateCall['migrate']>>[4] | undefined
    migrateBody(runtime, vi.fn(async (_id, _mid, _rev, _target, migrate) => {
      transform = migrate
      const migrated = migrate(legacyHeader, [
        { type: 'permission/preset', seq: 0, time: CREATED_AT, data: { preset: 'workspace-write' } },
        { type: 'turn/start', seq: 1, time: CREATED_AT + 1, data: { turn: 1 } },
        { type: 'step/start', seq: 2, time: CREATED_AT + 2, data: { turn: 1, step: 1 } },
        { type: 'user/message', seq: 3, time: CREATED_AT + 3, data: {
          content: [{ type: 'text', text: 'legacy prompt' }],
          source: { kind: 'user' },
        } },
        { type: 'assistant/message', seq: 4, time: CREATED_AT + 4, data: {
          turn: 1, step: 1, message: {
            id: 'm4', role: 'assistant',
            content: [{ type: 'text', text: 'legacy answer' }],
            source: { kind: 'model', provider: 'test', model: 'test' },
          },
        } },
        { type: 'step/end', seq: 5, time: CREATED_AT + 5, data: { turn: 1, step: 1 } },
        { type: 'turn/end', seq: 6, time: CREATED_AT + 6, data: { turn: 1, reason: { kind: 'completed' } } },
        { type: 'session/end-seed', seq: 7, time: CREATED_AT + 7, data: {} },
      ])
      expect(migrated.sessionFormatVersion).toBe(sessionFormatCatalog.currentVersion)
      expect(migrated.events.map((event: ConversationEvent) => event.seq)).toEqual(
        migrated.events.map((_event: ConversationEvent, index: number) => index),
      )
      for (const event of migrated.events as ConversationEvent[]) {
        if (event.type === 'system/message') {
          expect(event.surfaceOp).toBe('append')
        }
      }
      expect(migrated.events.filter((event: ConversationEvent) => event.type === 'session/end-seed')).toHaveLength(1)
      return {
        status: 'committed' as const,
        revision: '8:9',
        nextSeq: migrated.events.length,
        seedLength: migrated.seedLength,
      }
    }))
    const response = await migrateRequest(runtime)
    expect(response).toMatchObject({ handled: true, status: 200, body: { result: 'committed' } })
    expect(transform).toBeDefined()
  })

  it.each([
    ['a missing source revision', { sourceRevision: undefined }],
    ['another runtime\'s revision', {
      sourceRevision: `postgres:${ORGANIZATION_ID}:user:77:7:40`,
    }],
    ['a mismatched target id', {
      targetHeader: { id: 'session-other', version: sessionFormatCatalog.currentVersion, createdAt: CREATED_AT },
    }],
    ['a non-current target version', {
      targetHeader: { id: 'session-legacy', version: 2, createdAt: CREATED_AT },
    }],
  ])('rejects %s', async (_label, overrides) => {
    const runtime = fixture()
    const conversations = migrateBody(runtime)
    const response = await migrateRequest(runtime, overrides)
    expect(response.handled).toBe(true)
    expect(response.status).toBe(400)
    expect(conversations.migrate).not.toHaveBeenCalled()
  })

  it('hides sessions outside the caller scope', async () => {
    const runtime = fixture()
    const conversations = migrateBody(runtime)
    conversations.readHeader = vi.fn(async () => ({ ...legacyHeader, projectId: 'other-project' }))
    const response = await migrateRequest(runtime)
    expect(response).toMatchObject({ handled: true, status: 404, body: { error: 'conversation-not-found' } })
    expect(conversations.migrate).not.toHaveBeenCalled()
  })

  it('reports a revision conflict as a retryable dependency failure', async () => {
    const runtime = fixture()
    migrateBody(runtime, vi.fn(async () => {
      throw new ConversationReadError('dependency', 'conversation changed while its format migration was preparing')
    }))
    const response = await migrateRequest(runtime)
    expect(response).toMatchObject({ handled: true, status: 503, body: { code: 'dependency' } })
  })
})

describe('desktop coordination endpoints', () => {
  function desktopFixture() {
    const runtime = fixture()
    const database = new Database(':memory:')
    onTestFinished(() => { database.close() })
    const repo = new SqliteDesktopCoordinatorRepository(database)
    const desktops = new DesktopCoordinator(repo, { generationOf: async () => GENERATION })
    return { ...runtime, desktops, ready: desktops.initialize() }
  }

  const desktop = { node: 'node-a', desktop: 'seat-1' }

  it.each(['acquire', 'status', 'cancel', 'heartbeat', 'release', 'confirm-stopped'])(
    'rejects caller-supplied node or workflow identity on %s', async action => {
      const runtime = desktopFixture()
      await runtime.ready
      const handler = createRuntimeApiHandler({ ...runtime.deps, desktops: runtime.desktops })
      const response = await request(handler, `/internal/runtime/desktop/${action}`, {
        principal: runtime.issuePrincipal(CREATOR_ID),
        body: { ...desktop, requestId: 'r1', runId: 'forged-root' },
      })
      expect(response.status).toBe(400)
      expect(await runtime.desktops.listResources()).toEqual([])
    },
  )

  it('reports unavailable when the coordinator is absent', async () => {
    const runtime = fixture()
    const response = await request(runtime.handler, '/internal/runtime/desktop/acquire', {
      principal: runtime.issuePrincipal(CREATOR_ID), body: { ...desktop, requestId: 'r1' },
    })
    expect(response).toMatchObject({ status: 503, body: { error: 'desktop-coordination-unavailable' } })
  })

  it('rejects legacy acquisition without a registered execution Session', async () => {
    const runtime = desktopFixture()
    await runtime.ready
    const handler = createRuntimeApiHandler({ ...runtime.deps, desktops: runtime.desktops })
    const response = await request(handler, '/internal/runtime/desktop/acquire', {
      body: { ...desktop, requestId: 'r1' },
    })
    expect(response.status).toBe(400)
  })
})
