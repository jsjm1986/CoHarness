/** Session body operations retain authenticated organization and Runtime ownership. @module */
import { randomUUID } from 'node:crypto'
import { resolve } from 'node:path'
import type { Pool } from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { PostgresProgressService } from '../src/postgres/progress-service.ts'
import { literalSearchParts } from '../src/postgres/search-text.ts'
import type { RuntimeId } from '../src/runtime-catalog.ts'
import { ConversationRepository, PostgresConversationStore, type ConversationEvent, type ConversationHeader, type ConversationRuntimeScope } from '../src/postgres/conversation-repository.ts'
import { PostgresCollaborationService } from '../src/postgres/collaboration-service.ts'
import { ConversationArchiveService } from '../src/postgres/conversation-archive-service.ts'
import type { PostgresRuntimeContext } from '../src/postgres/runtime-context.ts'
import { createPostgresPool, runMigrations } from '../src/postgres/database.ts'
import { postgresTestDatabaseUrl } from './postgres-test-database.mjs'

const databaseUrl = postgresTestDatabaseUrl(process.env.HGW_TEST_DATABASE_URL)
const describePg = databaseUrl === undefined ? describe.skip : describe

describePg('Runtime-qualified PostgreSQL Session storage', () => {
  let administration: Pool | undefined, pool: Pool | undefined, database: string | undefined
  const owners: Array<ConversationRuntimeScope & { userId: string; publicId: number; repository: ConversationRepository; label: string; context: PostgresRuntimeContext; otherId: string; otherPublicId: number; projectId: string; projectPublicId: number; projectRuntimeId: RuntimeId }> = []
  beforeAll(async () => {
    administration = createPostgresPool(databaseUrl!, { max: 1 })
    const name = `conversation_namespace_${randomUUID().replaceAll('-', '')}_test`
    await administration.query(`CREATE DATABASE ${name}`); database = name
    const url = new URL(databaseUrl!); url.pathname = `/${name}`
    pool = createPostgresPool(url.toString(), { max: 2 })
    await runMigrations(pool, resolve(import.meta.dirname, '../deploy/postgres/migrations'))
    const store = new PostgresConversationStore(pool)
    for (const organizationIndex of [0, 1]) {
      const slug = randomUUID()
      const organizationId = (await pool.query<{ id: string }>("INSERT INTO harness.organizations(slug,display_name) VALUES($1,'Session ownership') RETURNING id", [slug])).rows[0]!.id
      const user = (await pool.query<{ id: string; public_id: string }>("INSERT INTO harness.users(organization_id,username,display_name,home_path) VALUES($1,'owner','Owner','/tmp/session-owner') RETURNING id,public_id", [organizationId])).rows[0]!
      const other = (await pool.query<{ id: string; public_id: string }>("INSERT INTO harness.users(organization_id,username,display_name,home_path) VALUES($1,'participant','Participant','/tmp/participant') RETURNING id,public_id", [organizationId])).rows[0]!
      await pool.query("INSERT INTO harness.memberships(organization_id,user_id,role,status) VALUES($1,$2,'member','active'),($1,$3,'member','active')", [organizationId, user.id, other.id])
      for (const computerIndex of organizationIndex === 0 ? [0, 1] : [0]) {
        const label = `organization-${organizationIndex}-computer-${computerIndex}`
        const nodeId = (await pool.query<{ id: string }>("INSERT INTO harness.compute_nodes(organization_id,name) VALUES($1,$2) RETURNING id", [organizationId, label])).rows[0]!.id
        await pool.query("INSERT INTO harness.node_user_accounts(organization_id,node_id,user_id,home_path) VALUES($1,$2,$3,'/tmp/session-owner')", [organizationId, nodeId, user.id])
        await pool.query('INSERT INTO harness.computer_use_permissions(organization_id,node_id,user_id,enabled) VALUES($1,$2,$3,true)', [organizationId, nodeId, user.id])
        const runtimeId = (await pool.query<{ runtime_id: RuntimeId }>(`INSERT INTO harness.instances(organization_id,user_id,assigned_node_id,port,storage_layout)
          VALUES($1,$2,$3,$4,'isolated') RETURNING runtime_id`, [organizationId, user.id, nodeId, 48000 + computerIndex])).rows[0]!.runtime_id
        await pool.query("INSERT INTO harness.node_user_accounts(organization_id,node_id,user_id,home_path) VALUES($1,$2,$3,'/tmp/participant')", [organizationId, nodeId, other.id])
        await pool.query('INSERT INTO harness.computer_use_permissions(organization_id,node_id,user_id,enabled) VALUES($1,$2,$3,true)', [organizationId, nodeId, other.id])
        const project = (await pool.query<{ id: string; public_id: string }>("INSERT INTO harness.projects(organization_id,name,created_by,owner_user_id) VALUES($1,$2,$3,$3) RETURNING id,public_id", [organizationId, label, user.id])).rows[0]!
        await pool.query("INSERT INTO harness.project_mounts(organization_id,project_id,node_id,local_path,canonical_path) VALUES($1,$2,$3,$4,$4)", [organizationId, project.id, nodeId, `/tmp/project-${project.id}`])
        await pool.query("INSERT INTO harness.project_members(organization_id,project_id,user_id,access_mode) VALUES($1,$2,$3,'rw'),($1,$2,$4,'rw')", [organizationId, project.id, user.id, other.id])
        const projectRuntimeId = (await pool.query<{ runtime_id: RuntimeId }>('INSERT INTO harness.instances(organization_id,project_id,assigned_node_id,port) VALUES($1,$2,$3,$4) RETURNING runtime_id', [organizationId, project.id, nodeId, 49000 + computerIndex])).rows[0]!.runtime_id
        const context = { pool, organizationId, organizationSlug: slug, nodeId, nodeName: label }
        owners.push({ organizationId, runtimeId, userId: user.id, publicId: Number(user.public_id), label, repository: store.forRuntime({ organizationId, runtimeId }), context, otherId: other.id, otherPublicId: Number(other.public_id), projectId: project.id, projectPublicId: Number(project.public_id), projectRuntimeId })
      }
    }
  })
  afterAll(async () => {
    const failures: unknown[] = [], close = async (action: () => Promise<unknown>): Promise<void> => { try { await action() } catch (error) { failures.push(error) } }
    if (pool !== undefined) await close(() => pool!.end())
    if (database !== undefined) await close(() => administration!.query(`DROP DATABASE ${database}`))
    if (administration !== undefined) await close(() => administration!.end())
    if (failures.length > 0) throw new AggregateError(failures, 'conversation namespace fixture teardown failed')
  })
  const header = (owner: typeof owners[number], id: string, extra: Partial<ConversationHeader> = {}): ConversationHeader => ({
    id, organizationId: owner.organizationId, runtimeId: owner.runtimeId, creatorUserId: owner.userId,
    visibility: 'personal', sessionFormatVersion: 1, createdAt: 1000, ...extra,
  })
  const body = (owner: typeof owners[number]): ConversationEvent[] => [
    { seq: 0, type: 'turn/start', time: 1000, data: { turn: 1 } },
    { seq: 1, type: 'user/message', time: 1001, data: { turn: 1, source: { kind: 'user', participant: { userId: owner.publicId } }, content: [{ type: 'text', text: `needle ${owner.label}` }] } },
    { seq: 2, type: 'turn/start', time: 1002, data: { turn: 2 } },
    { seq: 3, type: 'user/message', time: 1003, data: { turn: 2, source: { kind: 'user' }, content: [{ type: 'text', text: `tail ${owner.label}` }] } },
  ]

  it.each(['user', 'assistant', 'tool'] as const)('preserves a NUL-bearing %s message and its literal search text', async role => {
    const owner = owners[0]!, id = randomUUID(), content = 'left\u0000right\nUnicode 尾巴 %_\\ end'
    const blocks = [{ type: 'text', text: content }]
    const event: ConversationEvent = { seq: 0, time: 1000, type: role === 'tool' ? 'tool/result' : `${role}/message`,
      data: role === 'user' ? { source: { kind: 'user' }, content: blocks } : { message: { content: blocks } },
      ...(role === 'tool' ? {} : { surfaceOp: 'append' }) }
    expect(await owner.repository.append(id, randomUUID(), [event], header(owner, id))).toBe('inserted')
    expect((await owner.repository.load(id))?.events).toEqual([event])
    expect((await owner.repository.search(owner.organizationId, 'left')).find(row => row.sessionId === id)?.content).toBe(content)
    expect((await owner.repository.search(owner.organizationId, '\u0000')).find(row => row.sessionId === id)?.content).toBe(content)
  })

  it('retains NUL-bearing archive search content without changing its original text', async () => {
    const owner = owners[0]!, id = randomUUID(), content = 'archive-left\u0000archive-right'
    const service = new ConversationArchiveService(owner.context)
    const archiveId = await service.syncSnapshot({ rootSessionId: id, runtime: { kind: 'user', id: owner.publicId, runtimeId: owner.runtimeId }, creatorUserId: owner.publicId,
      syncRevision: 1, messageCount: 1, search: [{ sessionId: id, seq: 0, role: 'user', content, occurredAt: 1000 }] })
    expect((await service.adminList({ query: 'archive-right' })).some(row => row.archiveId === archiveId)).toBe(true)
    expect((await service.adminList({ query: '\u0000' })).some(row => row.archiveId === archiveId)).toBe(true)
  })

  it('includes NUL-bearing member messages in activity and pending progress', async () => {
    const owner = owners[0]!, id = randomUUID(), runtimeId = owner.projectRuntimeId
    const repository = new PostgresConversationStore(pool!).forRuntime({ organizationId: owner.organizationId, runtimeId })
    const collaboration = new PostgresCollaborationService(owner.context)
    const progress = new PostgresProgressService(owner.context, { collaboration })
    try {
      const before = (await progress.progressForUser(owner.projectPublicId, owner.publicId)).status.pending
      const event: ConversationEvent = { seq: 0, type: 'user/message', time: Date.now(), surfaceOp: 'append', data: {
        scopeKey: 'scope\u0000key', source: { kind: 'user', participant: { userId: owner.publicId, displayName: 'Name\u0000尾巴' } },
        content: [{ type: 'text', text: 'member\u0000activity' }],
      } }
      await repository.append(id, randomUUID(), [event], header(owner, id, { runtimeId, projectId: owner.projectId, visibility: 'project' }))
      const activity = await collaboration.listActivity(owner.publicId, runtimeId, owner.projectPublicId, { limit: 100 })
      expect(activity.items.find(row => row.sessionId === id)).toMatchObject({ text: 'member\u0000activity', actorLabel: 'Name\u0000尾巴', actorUserId: owner.publicId })
      expect((await progress.progressForUser(owner.projectPublicId, owner.publicId)).status.pending).toBe(before + 1)
    } finally { await progress.close() }
  })

  it('matches exact NUL boundaries without treating encoded text or line feeds as NUL', async () => {
    const owner = owners[0]!, id = randomUUID(), content = 'Aa\u0000bB\u0000\u0000C終\u0000%_\\'
    const service = new ConversationArchiveService(owner.context)
    const archiveId = await service.syncSnapshot({ rootSessionId: id, runtime: { kind: 'user', id: owner.publicId, runtimeId: owner.runtimeId }, creatorUserId: owner.publicId,
      syncRevision: 1, messageCount: 1, search: [{ sessionId: id, seq: 0, role: 'user', content, occurredAt: 1000 }] })
    for (const [query, expected] of [
      ['\u0000', true], ['\u0000\u0000', true], ['a\u0000B', true], ['bB\u0000\u0000c', true], ['C終\u0000%_\\', true],
      ['\u0000\u0000\u0000', false], ['a\nb', false], ['\\u0000', false], ['\uFFFD', false], ['bBC終', false], ['%_', true], ['not%_', false],
    ] as const) {
      expect((await service.adminList({ query })).some(row => row.archiveId === archiveId), JSON.stringify(query)).toBe(expected)
    }
    expect((await service.adminList()).find(row => row.archiveId === archiveId)?.contentPreview).toBe(content)
    await service.syncSnapshot({ rootSessionId: id, runtime: { kind: 'user', id: owner.publicId, runtimeId: owner.runtimeId }, creatorUserId: owner.publicId,
      syncRevision: 2, messageCount: 1, search: [{ sessionId: id, seq: 0, role: 'user', content: 'Ordinary replacement', occurredAt: 1001 }] })
    expect((await service.adminList({ query: '\u0000' })).some(row => row.archiveId === archiveId)).toBe(false)
    expect((await service.adminList({ query: 'Ordinary replacement' })).some(row => row.archiveId === archiveId)).toBe(true)
  })

  it('returns original bounded previews and keeps a NUL literal ahead of fuzzy alternatives', async () => {
    const owner = owners[0]!, id = randomUUID(), content = 'Aa\u0000bB\u0000\u0000C終😀\u0000%_\\'
    const events: ConversationEvent[] = [
      { seq: 0, type: 'turn/start', time: 1000, data: { turn: 1, scopeKey: 'turn\u0000scope' } },
      { seq: 1, type: 'user/message', time: 1001, surfaceOp: 'append', data: { source: { kind: 'user' }, content: [{ type: 'text', text: content }] } },
      { seq: 2, type: 'assistant/message', time: 1002, surfaceOp: 'append', data: { message: { content: [{ type: 'text', text: 'answer\u0000tail' }] } } },
    ]
    await owner.repository.append(id, randomUUID(), events, header(owner, id))
    const index = await owner.repository.readHistoryIndex(id)
    expect(index?.items[0]).toMatchObject({ prompt: content, response: 'answer\u0000tail' })
    const catalog = await new PostgresCollaborationService(owner.context).listAccountConversations(owner.publicId)
    expect(catalog.find(row => row.sessionId === id)?.title).toBe(content)
    const row = (await pool!.query<{ content: string; content_nul_parts: string[] }>(
      'SELECT content,content_nul_parts FROM harness.conversation_search WHERE organization_id=$1 AND runtime_id=$2 AND session_id=$3 AND event_seq=1', [owner.organizationId, owner.runtimeId, id])).rows[0]!
    for (let length = 0; length <= Array.from(content).length + 1; length += 1) {
      const preview = (await pool!.query<{ value: string }>('SELECT harness.conversation_search_text($1,$2::text[],$3) value', [row.content, row.content_nul_parts, length])).rows[0]!.value
      expect(preview).toBe(Array.from(content).slice(0, length).join(''))
    }
    await expect(pool!.query('SELECT harness.conversation_search_text($1,$2::text[],-1)', [row.content, row.content_nul_parts])).rejects.toMatchObject({ code: '22023' })
    for (const [query, expected] of [['a\u0000b', true], ['a\nb', false], ['\\u0000', false], ['\u0000\u0000', true]] as const) {
      const matched = (await pool!.query<{ value: boolean }>('SELECT harness.conversation_search_literal($1,$2::text[],$3::text[]) value', [row.content, row.content_nul_parts, literalSearchParts(query)])).rows[0]!.value
      expect(matched).toBe(expected)
    }
    const alternative = randomUUID(), needle = 'needle\u0000split'
    await owner.repository.append(alternative, randomUUID(), [{ seq: 0, type: 'user/message', time: 2000, data: { source: { kind: 'user' }, content: [{ type: 'text', text: 'needle split' }] } }], header(owner, alternative))
    const literalId = randomUUID()
    await owner.repository.append(literalId, randomUUID(), [{ seq: 0, type: 'user/message', time: 1000, data: { source: { kind: 'user' }, content: [{ type: 'text', text: 'prefix '.repeat(100) + needle + ' suffix'.repeat(100) }] } }], header(owner, literalId))
    expect((await owner.repository.search(owner.organizationId, needle, 1))[0]?.sessionId).toBe(literalId)
    expect((await owner.repository.load(id))?.events).toEqual(events)
  })

  it('retains long runs of empty NUL-separated pieces and bounds their previews', async () => {
    const owner = owners[0]!, id = randomUUID(), content = '\u0000'.repeat(16_000) + '尾巴😀'
    const events: ConversationEvent[] = [
      { seq: 0, type: 'turn/start', time: 1000, data: { turn: 1 } },
      { seq: 1, type: 'user/message', time: 1001, surfaceOp: 'append', data: { source: { kind: 'user' }, content: [{ type: 'text', text: content }] } },
    ]
    await owner.repository.append(id, randomUUID(), events, header(owner, id))
    expect((await owner.repository.load(id))?.events).toEqual(events)
    expect((await owner.repository.search(owner.organizationId, '\u0000\u0000尾巴😀')).find(row => row.sessionId === id)?.content).toBe(content)
    expect((await owner.repository.readHistoryIndex(id))?.items[0]?.prompt).toBe('\u0000'.repeat(160))
  })

  it('keeps equal Host ids and batch keys independent through reads, indexes, cursors and retries', async () => {
    const id = randomUUID(), batch = randomUUID()
    await Promise.all(owners.map(owner => owner.repository.append(id, batch, body(owner), header(owner, id))))
    for (const owner of owners) {
      const repository = owner.repository, events = body(owner)
      expect(await repository.append(id, batch, events)).toBe('duplicate')
      expect((await repository.load(id))?.events).toEqual(events)
      expect(await repository.readFrom(id, 1)).toEqual(events.slice(1))
      expect((await repository.readHeader(id))?.creatorUserId).toBe(owner.userId)
      expect(await repository.revision(id)).toBe('2:4')
      expect((await repository.list(owner.organizationId)).filter(item => item.id === id)).toHaveLength(1)
      expect((await repository.listScoped({ organizationId: owner.organizationId, runtimeId: owner.runtimeId })).filter(item => item.header.id === id)).toHaveLength(1)
      const found = (await repository.search(owner.organizationId, 'needle')).filter(item => item.sessionId === id)
      expect(found).toEqual([{ sessionId: id, seq: 1, content: `needle ${owner.label}` }])
      const index = await repository.readHistoryIndex(id)
      expect(index?.items.map(item => item.prompt)).toEqual([`needle ${owner.label}`, `tail ${owner.label}`])
      const page = await repository.readPage(id, { maxEvents: 1 })
      expect(page?.events).toEqual(events.slice(-1)); expect(page?.nextCursor).toBeTypeOf('string')
      expect((await repository.readPage(id, { cursor: page!.nextCursor, maxEvents: 1 }))?.events[0]?.seq).toBe(2)
      const other = owners.find(candidate => candidate.runtimeId !== owner.runtimeId)!
      await expect(other.repository.readPage(id, { cursor: page!.nextCursor, maxEvents: 1 })).rejects.toMatchObject({ code: 'protocol' })
    }
    const counts = (await pool!.query<{ runtime_id: RuntimeId; contribution_count: string }>('SELECT runtime_id,contribution_count FROM harness.conversation_participants WHERE conversation_id=$1', [id])).rows
    expect(counts).toHaveLength(3); expect(counts.every(item => Number(item.contribution_count) === 1)).toBe(true)
  })

  it('scopes parent inheritance, child metadata and batch-id reuse within the selected Runtime', async () => {
    const [a, b] = owners, root = randomUUID(), child = randomUUID(), batch = randomUUID()
    await Promise.all([a!, b!].map(owner => owner.repository.create(header(owner, root))))
    await a!.repository.append(child, batch, body(a!), header(a!, child, { parentSessionId: root }))
    expect((await a!.repository.load(root))?.header.id).toBe(root)
    expect((await a!.repository.listScoped({ organizationId: a!.organizationId, runtimeId: a!.runtimeId })).find(row => row.header.id === root)?.content.blank).toBe(false)
    expect((await b!.repository.listScoped({ organizationId: b!.organizationId, runtimeId: b!.runtimeId })).find(row => row.header.id === root)?.content.blank).toBe(true)
    expect(await b!.repository.load(child)).toBeUndefined()
    await expect(b!.repository.create(header(b!, randomUUID(), { parentSessionId: child }))).rejects.toThrow('unknown parent')
    const another = randomUUID(); await a!.repository.create(header(a!, another))
    await expect(a!.repository.append(another, batch, body(a!))).rejects.toThrow('batch id reused')
    expect((await a!.repository.load(another))?.events).toEqual([])
    await expect(a!.repository.create(header(b!, randomUUID()))).rejects.toThrow('another Runtime')
  })

  it('retains a migration predecessor and changes only the selected Runtime generation and search', async () => {
    const [a, b] = owners, id = randomUUID(), batch = randomUUID()
    for (const owner of [a!, b!]) await owner.repository.append(id, batch, body(owner), header(owner, id))
    const before = await a!.repository.load(id)
    const migrated = await a!.repository.migrate(id, 'same-migration-key', before!.revision, 2, (_header, events) => ({
      sessionFormatVersion: 2, seedLength: null, events: events.map(event => event.seq === 1 ? { ...event, data: { scopeKey: '\u0000', source: { kind: 'user' }, content: [{ type: 'text', text: 'migrated\u0000body' }] } } : event),
    }))
    expect(migrated.status).toBe('committed')
    expect((await a!.repository.load(id))?.header.sessionFormatVersion).toBe(2)
    expect((await a!.repository.search(a!.organizationId, 'migrated\u0000body')).find(row => row.sessionId === id)?.content).toBe('migrated\u0000body')
    expect((await b!.repository.load(id))?.events).toEqual(body(b!))
    expect((await b!.repository.load(id))?.header.sessionFormatVersion).toBe(1)
    expect((await a!.repository.search(a!.organizationId, 'needle')).filter(row => row.sessionId === id)).toEqual([])
    expect((await b!.repository.search(b!.organizationId, 'needle')).find(row => row.sessionId === id)?.content).toBe(`needle ${b!.label}`)
    const retained = (await pool!.query<{ event: ConversationEvent }>('SELECT event FROM harness.conversation_migrated_events WHERE organization_id=$1 AND runtime_id=$2 AND session_id=$3 ORDER BY seq', [a!.organizationId, a!.runtimeId, id])).rows
    expect(retained.map(row => row.event)).toEqual(before!.events)
    expect(await b!.repository.migrate(id, 'same-migration-key', (await b!.repository.revision(id))!, 2, (_header, events) => ({ sessionFormatVersion: 2, seedLength: null, events }))).toMatchObject({ status: 'committed' })
    expect((await pool!.query('SELECT id FROM harness.conversation_migrations WHERE session_id=$1', [id])).rowCount).toBe(2)
  })

  it('isolates equal draft keys, owner heartbeats, releases and tree removal with file references', async () => {
    const [a, b] = owners, id = randomUUID(), draftId = randomUUID(), scopeKey = randomUUID()
    for (const owner of [a!, b!]) {
      const input = { organizationId: owner.organizationId, runtimeId: owner.runtimeId, scopeKey, draftId, sessionId: id, userId: owner.userId, cwd: '/tmp/draft', visibility: 'personal' as const }
      expect(await owner.repository.reserveDraft(input)).toMatchObject({ created: true, sessionId: id })
      expect(await owner.repository.reserveDraft(input)).toMatchObject({ created: false, sessionId: id })
    }
    await a!.repository.releaseDraft(a!.organizationId, scopeKey, draftId)
    expect(await a!.repository.heartbeatDraft(a!.organizationId, scopeKey, draftId, id)).toBe(false)
    expect(await b!.repository.heartbeatDraftForOwner({ organizationId: b!.organizationId, draftId, sessionId: id, userId: b!.userId })).toBe(true)
    for (const owner of [a!, b!]) {
      await owner.repository.append(id, randomUUID(), body(owner), header(owner, id))
      await pool!.query(`INSERT INTO harness.content_files(organization_id,runtime_id,owner_user_id,session_id,kind,local_path,sha256,byte_length,media_type)
        VALUES($1,$2,$3,$4,'attachment',$5,$6,1,'text/plain')`, [owner.organizationId, owner.runtimeId, owner.userId, id, `/tmp/${owner.runtimeId}/${id}`, 'a'.repeat(64)])
    }
    expect(await a!.repository.removeTree(a!.organizationId, id)).toEqual([`/tmp/${a!.runtimeId}/${id}`])
    expect(await a!.repository.load(id)).toBeUndefined()
    expect((await b!.repository.load(id))?.events).toEqual(body(b!))
    expect(await b!.repository.heartbeatDraft(b!.organizationId, scopeKey, draftId, id)).toBe(true)
    expect((await pool!.query('SELECT id FROM harness.content_files WHERE organization_id=$1 AND runtime_id=$2 AND session_id=$3', [b!.organizationId, b!.runtimeId, id])).rowCount).toBe(1)
    await b!.repository.releaseDraftForOwner({ organizationId: b!.organizationId, draftId, sessionId: id, userId: b!.userId })
    expect(await b!.repository.heartbeatDraftForOwner({ organizationId: b!.organizationId, draftId, sessionId: id, userId: b!.userId })).toBe(false)
  })
  it('keeps collaboration lists, visibility, contributions and interaction claims on the selected project Runtime', async () => {
    const id = randomUUID(), batch = randomUUID(), interaction = randomUUID()
    const selected = owners.map(owner => ({ ...owner, runtimeId: owner.projectRuntimeId,
      repository: new PostgresConversationStore(pool!).forRuntime({ organizationId: owner.organizationId, runtimeId: owner.projectRuntimeId }),
      collaboration: new PostgresCollaborationService(owner.context) }))
    for (const [index, owner] of selected.entries()) {
      await owner.repository.append(id, batch, body(owner), header(owner, id, { projectId: owner.projectId, visibility: index === 0 ? 'private' : 'project' }))
      expect(await owner.collaboration.access(owner.publicId, owner.runtimeId, id, 'manage')).toMatchObject({ projectId: owner.projectPublicId, rootSessionId: id })
      expect((await owner.collaboration.listConversations(owner.publicId, owner.runtimeId, owner.projectPublicId)).filter(row => row.sessionId === id)).toHaveLength(1)
      const outcome = { answers: [{ selected: [owner.label] }] }
      expect(await owner.collaboration.claimInteraction(owner.publicId, owner.runtimeId, id, 'question', interaction, outcome)).toBe(true)
      expect(await owner.collaboration.claimInteraction(owner.publicId, owner.runtimeId, id, 'question', interaction, outcome)).toBe(false)
      const activity = await owner.collaboration.listActivity(owner.publicId, owner.runtimeId, owner.projectPublicId, { limit: 100 })
      expect(activity.items.filter(item => item.sessionId === id).map(item => item.text)).toEqual(expect.arrayContaining([`needle ${owner.label}`, owner.label]))
      expect(activity.items.filter(item => item.sessionId === id).every(item => !item.text.includes('needle organization-') || item.text.includes(owner.label))).toBe(true)
    }
    const [a, b] = selected
    await expect(a!.collaboration.access(a!.otherPublicId, a!.runtimeId, id, 'read')).rejects.toMatchObject({ code: 'forbidden' })
    expect(await b!.collaboration.readableSessionIds(b!.otherPublicId, b!.runtimeId, b!.projectPublicId, [id])).toEqual([id])
    expect(await a!.collaboration.readableSessionIds(a!.otherPublicId, a!.runtimeId, a!.projectPublicId, [id])).toEqual([])
    await expect(a!.collaboration.access(a!.publicId, b!.runtimeId, id, 'read')).rejects.toMatchObject({ code: 'conversation-not-found' })
    const catalog = await a!.collaboration.listAccountConversations(a!.publicId)
    const sameName = catalog.filter(row => row.sessionId === id)
    expect(sameName.map(row => row.runtime.runtimeId).sort()).toEqual([a!.runtimeId, b!.runtimeId].sort())
    expect(sameName.find(row => row.runtime.runtimeId === a!.runtimeId)?.title).toBe(`needle ${a!.label}`)
    expect(sameName.find(row => row.runtime.runtimeId === b!.runtimeId)?.title).toBe(`needle ${b!.label}`)
    await b!.repository.append(id, randomUUID(), [{ seq: 4, type: 'user/message', time: 1004, data: {
      source: { kind: 'user', participant: { userId: b!.otherPublicId } }, content: [{ type: 'text', text: 'Other contribution' }],
    } }])
    await a!.collaboration.setVisibility(a!.publicId, a!.runtimeId, id, 'project')
    await a!.collaboration.setVisibility(a!.publicId, a!.runtimeId, id, 'private')
    await expect(b!.collaboration.setVisibility(b!.publicId, b!.runtimeId, id, 'private')).rejects.toMatchObject({ code: 'visibility-locked' })
    expect((await b!.repository.readHeader(id))?.visibility).toBe('project')
  })

  it('selects blank-root maintenance by Runtime and preserves a same-computer personal sibling', async () => {
    const a = owners[0]!, id = randomUUID(), service = new ConversationArchiveService(a.context)
    const projectRepository = new PostgresConversationStore(pool!).forRuntime({ organizationId: a.organizationId, runtimeId: a.projectRuntimeId })
    await a.repository.create(header(a, id))
    await projectRepository.create(header(a, id, { runtimeId: a.projectRuntimeId, projectId: a.projectId, visibility: 'project' }))
    await pool!.query("UPDATE harness.memberships SET role='admin' WHERE organization_id=$1 AND user_id=$2", [a.organizationId, a.userId])
    const preview = await service.previewEmptyDrafts({ olderThanMs: 0 }, a.publicId)
    expect(preview.candidates.filter(row => row.rootSessionId === id).map(row => row.runtime.runtimeId).sort()).toEqual([a.runtimeId, a.projectRuntimeId].sort())
    const selected = { rootSessionId: id, runtimeId: a.projectRuntimeId }
    expect(await service.trashEmptyDrafts([selected], a.publicId, preview.cutoff)).toEqual([selected])
    const records = (await pool!.query<{ runtime_id: RuntimeId; state: string }>('SELECT runtime_id,state FROM harness.conversation_archive_records WHERE organization_id=$1 AND root_session_id=$2', [a.organizationId, id])).rows
    expect(records).toEqual([{ runtime_id: a.projectRuntimeId, state: 'trash' }])
    expect((await a.repository.load(id))?.events).toEqual([])
    expect((await service.previewEmptyDrafts({ olderThanMs: 0 }, a.publicId)).candidates.some(row => row.rootSessionId === id && row.runtime.runtimeId === a.runtimeId)).toBe(true)
  })

})
