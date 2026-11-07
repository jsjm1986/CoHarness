import { Client, Pool } from 'pg'
import { describe, expect, it, vi } from 'vitest'
import { PostgresDocumentCatalogService } from '../src/postgres/document-catalog-service.ts'

const context = {
  organizationId: 'org-1', organizationSlug: 'org', nodeId: 'node-1', nodeName: 'node',
}

describe('PostgresDocumentCatalogService sync', () => {
  it('upserts a document batch and its history with one query per phase', async () => {
    const calls: Array<{ text: string; values?: readonly unknown[] }> = []
    const client = Object.assign(new Client({ connectionString: 'postgresql://fixture:fixture@127.0.0.1:1/fixture_test' }), {
      query: vi.fn(async (text: string, values?: readonly unknown[]) => {
        calls.push({ text, values })
        if (text.includes('FROM harness.users u')) return { rows: [{ id: 'actor-id', public_id: '7', display_name: 'User' }], rowCount: 1 }
        if (text.includes('SELECT id,public_id::text,display_name')) {
          return { rows: [{ id: 'owner-id', public_id: '7', display_name: 'Owner' }], rowCount: 1 }
        }
        if (text.includes('SELECT id,runtime_doc_id,owner_user_id,state')) {
          return { rows: [{ id: 'old-id', runtime_doc_id: 'old.txt', owner_user_id: null, state: 'trash' }], rowCount: 1 }
        }
        if (text.includes('INSERT INTO harness.document_catalog')) {
          return { rows: [
            { id: 'old-id', runtime_doc_id: 'old.txt' },
            { id: 'new-id', runtime_doc_id: 'new.txt' },
          ], rowCount: 2 }
        }
        return { rows: [], rowCount: 0 }
      }),
      release: vi.fn(),
    })
    const pool = Object.assign(new Pool({ connectionString: 'postgresql://fixture:fixture@127.0.0.1:1/fixture_test' }), {
      connect: vi.fn(async () => client),
    })
    const service = new PostgresDocumentCatalogService({ ...context, pool })

    await service.sync({
      actorUserId: 7,
      scope: { kind: 'personal', userId: 7 },
      documents: [
        { docId: 'old.txt', name: 'old.txt', bytes: 1, mediaType: 'text/plain', modifiedAt: 1 },
        { docId: 'new.txt', name: 'new.txt', bytes: 2, mediaType: 'text/plain', modifiedAt: 2 },
      ],
      ownerSource: 'upload',
    })

    const catalogWrites = calls.filter(call => call.text.includes('INSERT INTO harness.document_catalog'))
    const historyWrites = calls.filter(call => call.text.includes('INSERT INTO harness.document_history'))
    expect(catalogWrites).toHaveLength(1)
    expect(catalogWrites[0]?.text).toContain('FROM unnest(')
    expect(historyWrites).toHaveLength(1)
    expect(historyWrites[0]?.text).toContain('FROM unnest(')
    expect(historyWrites[0]?.values?.[3]).toEqual(['restored', 'created'])
  })

  it('rejects duplicate runtime ids before opening a transaction', async () => {
    const pool = Object.assign(new Pool({ connectionString: 'postgresql://fixture:fixture@127.0.0.1:1/fixture_test' }), { connect: vi.fn() })
    const service = new PostgresDocumentCatalogService({ ...context, pool })
    await expect(service.sync({
      actorUserId: 7, scope: { kind: 'personal', userId: 7 },
      documents: [
        { docId: 'same.txt', name: 'same.txt', bytes: 1, mediaType: 'text/plain', modifiedAt: 1 },
        { docId: 'same.txt', name: 'same.txt', bytes: 1, mediaType: 'text/plain', modifiedAt: 1 },
      ],
    })).rejects.toMatchObject({ code: 'INVALID_DOCUMENT_METADATA', status: 400 })
    expect(pool.connect).not.toHaveBeenCalled()
  })

  it('reconciles missing active rows with one update and one history insert', async () => {
    const calls: string[] = []
    const client = Object.assign(new Client({ connectionString: 'postgresql://fixture:fixture@127.0.0.1:1/fixture_test' }), {
      query: vi.fn(async (text: string) => {
        calls.push(text)
        if (text.includes('FROM harness.users u')) return { rows: [{ id: 'actor-id', public_id: '7', display_name: 'User' }], rowCount: 1 }
        if (text.includes('SELECT id,public_id::text,display_name')) {
          return { rows: [{ id: 'owner-id', public_id: '7', display_name: 'Owner' }], rowCount: 1 }
        }
        if (text.includes('SELECT id,runtime_doc_id,owner_user_id,state')) {
          return { rows: [{ id: 'missing-id', runtime_doc_id: 'missing.txt', owner_user_id: 'owner-id', state: 'active' }], rowCount: 1 }
        }
        if (text.includes('INSERT INTO harness.document_catalog')) return { rows: [{ id: 'new-id', runtime_doc_id: 'new.txt' }], rowCount: 1 }
        if (text.includes('UPDATE harness.document_catalog AS catalog')) return { rows: [{ id: 'missing-id' }], rowCount: 1 }
        return { rows: [], rowCount: 0 }
      }),
      release: vi.fn(),
    })
    const pool = Object.assign(new Pool({ connectionString: 'postgresql://fixture:fixture@127.0.0.1:1/fixture_test' }), {
      connect: vi.fn(async () => client),
    })
    const service = new PostgresDocumentCatalogService({ ...context, pool })

    await service.sync({
      actorUserId: 7,
      scope: { kind: 'personal', userId: 7 },
      documents: [{ docId: 'new.txt', name: 'new.txt', bytes: 2, mediaType: 'text/plain', modifiedAt: 2 }],
      replace: true,
    })

    expect(calls.filter(text => text.includes('UPDATE harness.document_catalog AS catalog'))).toHaveLength(1)
    expect(calls.filter(text => text.includes('INSERT INTO harness.document_history'))).toHaveLength(2)
    expect(calls.some(text => text.includes('FROM unnest($2::uuid[])'))).toBe(true)
  })

  it('does not let an equal-revision stale incarnation replace a newer active path', async () => {
    const calls: string[] = []
    const client = Object.assign(new Client({ connectionString: 'postgresql://fixture:fixture@127.0.0.1:1/fixture_test' }), {
      query: vi.fn(async (text: string) => {
        calls.push(text)
        if (text.includes('FROM harness.users u')) return { rows: [{ id: 'actor-id', public_id: '7', display_name: 'User' }], rowCount: 1 }
        if (text.includes('SELECT id,public_id::text,display_name')) {
          return { rows: [{ id: 'owner-id', public_id: '7', display_name: 'Owner' }], rowCount: 1 }
        }
        if (text.includes('SELECT id,state,runtime_revision')) {
          return { rows: [{ id: 'old-id', state: 'missing', runtime_revision: 1 }], rowCount: 1 }
        }
        if (text.includes('SELECT id,runtime_incarnation_id')) {
          return { rows: [{ id: 'replacement-id', runtime_incarnation_id: '22222222-2222-4222-8222-222222222222' }], rowCount: 1 }
        }
        return { rows: [], rowCount: 0 }
      }),
      release: vi.fn(),
    })
    const pool = Object.assign(new Pool({ connectionString: 'postgresql://fixture:fixture@127.0.0.1:1/fixture_test' }), {
      connect: vi.fn(async () => client),
    })
    const service = new PostgresDocumentCatalogService({ ...context, pool })

    await service.sync({
      actorUserId: 7,
      scope: { kind: 'personal', userId: 7 },
      documents: [{ docId: 'same.txt', name: 'same.txt', bytes: 1, mediaType: 'text/plain', modifiedAt: 1,
        identity: { incarnationId: '11111111-1111-4111-8111-111111111111', revision: 1, origin: 'upload' } }],
    })

    expect(calls.some(text => text.includes('SELECT id,runtime_incarnation_id'))).toBe(false)
    expect(calls.some(text => text.includes('UPDATE harness.document_catalog'))).toBe(false)
    expect(calls.some(text => text.includes('INSERT INTO harness.document_catalog'))).toBe(false)
    expect(calls.some(text => text.includes('INSERT INTO harness.document_history'))).toBe(false)
  })

  it('marks the old incarnation missing before registering a new incarnation at the reused path', async () => {
    const calls: Array<{ text: string; values?: readonly unknown[] }> = []
    const client = Object.assign(new Client({ connectionString: 'postgresql://fixture:fixture@127.0.0.1:1/fixture_test' }), {
      query: vi.fn(async (text: string, values?: readonly unknown[]) => {
        calls.push({ text, values })
        if (text.includes('FROM harness.users u')) return { rows: [{ id: 'actor-id', public_id: '7', display_name: 'User' }], rowCount: 1 }
        if (text.includes('SELECT id,public_id::text,display_name')) {
          return { rows: [{ id: 'owner-id', public_id: '7', display_name: 'Owner' }], rowCount: 1 }
        }
        if (text.includes('SELECT id,state,runtime_revision')) return { rows: [], rowCount: 0 }
        if (text.includes('SELECT id,runtime_incarnation_id')) {
          return { rows: [{ id: 'old-id', runtime_incarnation_id: '11111111-1111-4111-8111-111111111111' }], rowCount: 1 }
        }
        if (text.includes('INSERT INTO harness.document_catalog')) return { rows: [{ id: 'new-id' }], rowCount: 1 }
        return { rows: [], rowCount: 0 }
      }),
      release: vi.fn(),
    })
    const pool = Object.assign(new Pool({ connectionString: 'postgresql://fixture:fixture@127.0.0.1:1/fixture_test' }), {
      connect: vi.fn(async () => client),
    })
    const service = new PostgresDocumentCatalogService({ ...context, pool })

    await service.sync({
      actorUserId: 7,
      scope: { kind: 'personal', userId: 7 },
      documents: [{ docId: 'same.txt', name: 'same.txt', bytes: 2, mediaType: 'text/plain', modifiedAt: 2,
        identity: { incarnationId: '22222222-2222-4222-8222-222222222222', revision: 1, origin: 'upload' } }],
    })

    const replacement = calls.find(call => call.text.includes("UPDATE harness.document_catalog SET state='missing'"))
    expect(replacement, calls.map(call => call.text).join('\n---\n')).toBeDefined()
    expect(replacement?.values).toEqual(['org-1', 'old-id'])
    expect(calls.some(call => call.text.includes('INSERT INTO harness.document_catalog')
      && call.values?.includes('22222222-2222-4222-8222-222222222222'))).toBe(true)
    expect(calls.filter(call => call.text.includes('INSERT INTO harness.document_history'))).toHaveLength(2)
  })

  it('does not project an equal-revision missing event over a newer active path incarnation', async () => {
    const calls: string[] = []
    const client = Object.assign(new Client({ connectionString: 'postgresql://fixture:fixture@127.0.0.1:1/fixture_test' }), {
      query: vi.fn(async (text: string) => {
        calls.push(text)
        if (text.includes('FROM harness.users u')) return { rows: [{ id: 'owner-id', public_id: '7', display_name: 'User' }], rowCount: 1 }
        if (text.includes('SELECT id,public_id::text,display_name')) {
          return { rows: [{ id: 'owner-id', public_id: '7', display_name: 'Owner' }], rowCount: 1 }
        }
        if (text.includes('SELECT scope_kind,scope_user_id,scope_project_id,sequence,ordinal')) {
          return { rows: [{ scope_kind: 'personal', scope_user_id: 'owner-id', scope_project_id: null, sequence: 1, ordinal: 1 }], rowCount: 1 }
        }
        if (text.includes('SELECT id,runtime_revision,state')) {
          return { rows: [{ id: 'old-id', runtime_revision: 3, state: 'missing' }], rowCount: 1 }
        }
        return { rows: [], rowCount: 0 }
      }),
      release: vi.fn(),
    })
    const pool = Object.assign(new Pool({ connectionString: 'postgresql://fixture:fixture@127.0.0.1:1/fixture_test' }), {
      connect: vi.fn(async () => client),
    })
    const service = new PostgresDocumentCatalogService({ ...context, pool })
    const after = { sequence: 1, ordinal: 1 }, next = { sequence: 1, ordinal: 2 }

    await expect(service.project(7, { kind: 'personal', userId: 7 }, {
      rootId: '33333333-3333-4333-8333-333333333333', after, head: next, next, hasMore: false,
      changes: [{ previous: after, cursor: next, action: 'missing', committedAt: 5,
        document: { incarnationId: '11111111-1111-4111-8111-111111111111', revision: 3, docId: 'same.txt', state: 'missing',
          origin: 'upload', bytes: 1, mediaType: 'text/plain', modifiedAt: 1 } }],
    })).resolves.toEqual(next)

    expect(calls.some(text => text.includes('SELECT id,runtime_incarnation_id'))).toBe(false)
    expect(calls.some(text => text.includes('UPDATE harness.document_catalog'))).toBe(false)
    expect(calls.some(text => text.includes('INSERT INTO harness.document_catalog'))).toBe(false)
    expect(calls.some(text => text.includes('INSERT INTO harness.document_history'))).toBe(false)
  })

  it('projects a new active incarnation after marking the previous path incarnation missing', async () => {
    const calls: Array<{ text: string; values?: readonly unknown[] }> = []
    const client = Object.assign(new Client({ connectionString: 'postgresql://fixture:fixture@127.0.0.1:1/fixture_test' }), {
      query: vi.fn(async (text: string, values?: readonly unknown[]) => {
        calls.push({ text, values })
        if (text.includes('FROM harness.users u')) return { rows: [{ id: 'owner-id', public_id: '7', display_name: 'User' }], rowCount: 1 }
        if (text.includes('SELECT id,public_id::text,display_name')) {
          return { rows: [{ id: 'owner-id', public_id: '7', display_name: 'Owner' }], rowCount: 1 }
        }
        if (text.includes('SELECT scope_kind,scope_user_id,scope_project_id,sequence,ordinal')) {
          return { rows: [{ scope_kind: 'personal', scope_user_id: 'owner-id', scope_project_id: null, sequence: 1, ordinal: 1 }], rowCount: 1 }
        }
        if (text.includes('SELECT id,runtime_revision,state')) return { rows: [], rowCount: 0 }
        if (text.includes('SELECT id,runtime_incarnation_id')) {
          return { rows: [{ id: 'old-id', runtime_incarnation_id: '11111111-1111-4111-8111-111111111111' }], rowCount: 1 }
        }
        if (text.includes('INSERT INTO harness.document_catalog')) return { rows: [{ id: 'new-id' }], rowCount: 1 }
        return { rows: [], rowCount: 0 }
      }),
      release: vi.fn(),
    })
    const pool = Object.assign(new Pool({ connectionString: 'postgresql://fixture:fixture@127.0.0.1:1/fixture_test' }), {
      connect: vi.fn(async () => client),
    })
    const service = new PostgresDocumentCatalogService({ ...context, pool })
    const after = { sequence: 1, ordinal: 1 }, next = { sequence: 1, ordinal: 2 }

    await expect(service.project(7, { kind: 'personal', userId: 7 }, {
      rootId: '33333333-3333-4333-8333-333333333333', after, head: next, next, hasMore: false,
      changes: [{ previous: after, cursor: next, action: 'publish', committedAt: 5,
        document: { incarnationId: '22222222-2222-4222-8222-222222222222', revision: 1, docId: 'same.txt', state: 'active',
          origin: 'upload', bytes: 2, mediaType: 'text/plain', modifiedAt: 2 } }],
    })).resolves.toEqual(next)

    expect(calls.some(call => call.text.includes("UPDATE harness.document_catalog SET state='missing'"))
      && calls.some(call => call.text.includes('INSERT INTO harness.document_catalog')
        && call.values?.includes('22222222-2222-4222-8222-222222222222'))).toBe(true)
    expect(calls.filter(call => call.text.includes('INSERT INTO harness.document_history'))).toHaveLength(2)
  })

  it('marks a removed document batch with one update and one history insert', async () => {
    const calls: Array<{ text: string; values?: readonly unknown[] }> = []
    const client = Object.assign(new Client({ connectionString: 'postgresql://fixture:fixture@127.0.0.1:1/fixture_test' }), {
      query: vi.fn(async (text: string, values?: readonly unknown[]) => {
        calls.push({ text, values })
        if (text.includes('FROM harness.users u')) return { rows: [{ id: 'actor-id', public_id: '7', display_name: 'User' }], rowCount: 1 }
        if (text.includes('SELECT id,public_id::text,display_name')) {
          return { rows: [{ id: 'owner-id', public_id: '7', display_name: 'Owner' }], rowCount: 1 }
        }
        if (text.includes('runtime_doc_id=ANY($5::text[])')) {
          return { rows: [{ id: 'doc-a' }, { id: 'doc-b' }], rowCount: 2 }
        }
        if (text.includes('UPDATE harness.document_catalog AS catalog')) {
          return { rows: [{ id: 'doc-a' }, { id: 'doc-b' }], rowCount: 2 }
        }
        return { rows: [], rowCount: 0 }
      }),
      release: vi.fn(),
    })
    const pool = Object.assign(new Pool({ connectionString: 'postgresql://fixture:fixture@127.0.0.1:1/fixture_test' }), {
      connect: vi.fn(async () => client),
    })
    const service = new PostgresDocumentCatalogService({ ...context, pool })

    await service.markDeletedBatch(7, { kind: 'personal', userId: 7 }, ['a.txt', 'b.txt', 'a.txt'])

    const update = calls.filter(call => call.text.includes('UPDATE harness.document_catalog AS catalog'))
    const history = calls.filter(call => call.text.includes('INSERT INTO harness.document_history'))
    expect(calls.find(call => call.text.includes('runtime_doc_id=ANY($5::text[])'))?.values?.[4]).toEqual(['a.txt', 'b.txt'])
    expect(update).toHaveLength(1)
    expect(update[0]?.values?.[7]).toEqual(['doc-a', 'doc-b'])
    expect(history).toHaveLength(1)
  })

  it('purges one exact trash action once and accepts the identical retry', async () => {
    const calls: Array<{ text: string; values?: readonly unknown[] }> = []
    let current: { state: string; runtime_revision: number; trash_action_id: string | null } = {
      state: 'trash', runtime_revision: 4, trash_action_id: '22222222-2222-4222-8222-222222222222',
    }
    const client = Object.assign(new Client({ connectionString: 'postgresql://fixture:fixture@127.0.0.1:1/fixture_test' }), {
      query: vi.fn(async (text: string, values?: readonly unknown[]) => {
        calls.push({ text, values })
        if (text.includes('FROM harness.users u')) return { rows: [{ id: 'actor-id', public_id: '7', display_name: 'User' }], rowCount: 1 }
        if (text.includes('SELECT id,public_id::text,display_name')) {
          return { rows: [{ id: 'owner-id', public_id: '7', display_name: 'Owner' }], rowCount: 1 }
        }
        if (text.includes("SET state='purged',runtime_revision=$7")) {
          if (current.state === 'trash' && values?.[6] === 5 && values?.[8] === current.trash_action_id) {
            current = { state: 'purged', runtime_revision: 5, trash_action_id: null }
            return { rows: [{ id: 'doc-id' }], rowCount: 1 }
          }
          return { rows: [], rowCount: 0 }
        }
        if (text.includes('SELECT state,runtime_revision,trash_action_id')) {
          return { rows: [current], rowCount: 1 }
        }
        return { rows: [], rowCount: 0 }
      }),
      release: vi.fn(),
    })
    const pool = Object.assign(new Pool({ connectionString: 'postgresql://fixture:fixture@127.0.0.1:1/fixture_test' }), {
      connect: vi.fn(async () => client),
    })
    const service = new PostgresDocumentCatalogService({ ...context, pool })
    const removal = { docId: 'a.txt', incarnationId: '11111111-1111-4111-8111-111111111111', revision: 5,
      trashId: '22222222-2222-4222-8222-222222222222', state: 'purged' as const }

    await service.markDeletedBatch(7, { kind: 'personal', userId: 7 }, [removal])
    await service.markDeletedBatch(7, { kind: 'personal', userId: 7 }, [removal])

    const updates = calls.filter(call => call.text.includes("SET state='purged',runtime_revision=$7"))
    expect(updates).toHaveLength(2)
    expect(updates.every(call => call.text.includes('runtime_doc_id=$5 AND runtime_incarnation_id=$6 AND runtime_revision=$7-1')
      && call.text.includes('trash_action_id=$9 AND state=\'trash\'')
      && call.values?.[4] === 'a.txt' && call.values[5] === removal.incarnationId
      && call.values[6] === removal.revision && call.values[8] === removal.trashId)).toBe(true)
    expect(calls.filter(call => call.text.includes('INSERT INTO harness.document_history'))).toHaveLength(1)
  })
})
