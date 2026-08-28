import type { Pool, PoolClient } from 'pg'
import { describe, expect, it, vi } from 'vitest'
import { PostgresDocumentCatalogService } from '../src/postgres/document-catalog-service.ts'

const context = {
  organizationId: 'org-1', organizationSlug: 'org', nodeId: 'node-1', nodeName: 'node',
  pool: undefined as unknown as Pool,
}

describe('PostgresDocumentCatalogService sync', () => {
  it('upserts a document batch and its history with one query per phase', async () => {
    const calls: Array<{ text: string; values?: readonly unknown[] }> = []
    const client = {
      query: vi.fn(async (text: string, values?: readonly unknown[]) => {
        calls.push({ text, values })
        if (text.includes('SELECT id FROM harness.users')) return { rows: [{ id: 'actor-id' }], rowCount: 1 }
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
    } as unknown as PoolClient
    const pool = { connect: vi.fn(async () => client) } as unknown as Pool
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
    const pool = { connect: vi.fn() } as unknown as Pool
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
    const client = {
      query: vi.fn(async (text: string) => {
        calls.push(text)
        if (text.includes('SELECT id FROM harness.users')) return { rows: [{ id: 'actor-id' }], rowCount: 1 }
        if (text.includes('SELECT id,public_id::text,display_name')) {
          return { rows: [{ id: 'owner-id', public_id: '7', display_name: 'Owner' }], rowCount: 1 }
        }
        if (text.includes('SELECT id,runtime_doc_id,owner_user_id,state')) return { rows: [], rowCount: 0 }
        if (text.includes('INSERT INTO harness.document_catalog')) return { rows: [{ id: 'new-id', runtime_doc_id: 'new.txt' }], rowCount: 1 }
        if (text.includes("AND state='active'")) {
          return { rows: [{ id: 'missing-id', runtime_doc_id: 'missing.txt' }], rowCount: 1 }
        }
        if (text.includes('UPDATE harness.document_catalog AS catalog')) return { rows: [{ id: 'missing-id' }], rowCount: 1 }
        return { rows: [], rowCount: 0 }
      }),
      release: vi.fn(),
    } as unknown as PoolClient
    const pool = { connect: vi.fn(async () => client) } as unknown as Pool
    const service = new PostgresDocumentCatalogService({ ...context, pool })

    await service.sync({
      actorUserId: 7,
      scope: { kind: 'personal', userId: 7 },
      documents: [{ docId: 'new.txt', name: 'new.txt', bytes: 2, mediaType: 'text/plain', modifiedAt: 2 }],
      replace: true,
    })

    expect(calls.filter(text => text.includes('UPDATE harness.document_catalog AS catalog'))).toHaveLength(1)
    expect(calls.filter(text => text.includes('INSERT INTO harness.document_history'))).toHaveLength(2)
    expect(calls.some(text => text.includes('FROM unnest($5::uuid[])'))).toBe(true)
  })

  it('marks a removed document batch with one update and one history insert', async () => {
    const calls: Array<{ text: string; values?: readonly unknown[] }> = []
    const client = {
      query: vi.fn(async (text: string, values?: readonly unknown[]) => {
        calls.push({ text, values })
        if (text.includes('SELECT id FROM harness.users')) return { rows: [{ id: 'actor-id' }], rowCount: 1 }
        if (text.includes('SELECT id,public_id::text,display_name')) {
          return { rows: [{ id: 'owner-id', public_id: '7', display_name: 'Owner' }], rowCount: 1 }
        }
        if (text.includes('UPDATE harness.document_catalog AS catalog')) {
          return { rows: [{ id: 'doc-a' }, { id: 'doc-b' }], rowCount: 2 }
        }
        return { rows: [], rowCount: 0 }
      }),
      release: vi.fn(),
    } as unknown as PoolClient
    const pool = { connect: vi.fn(async () => client) } as unknown as Pool
    const service = new PostgresDocumentCatalogService({ ...context, pool })

    await service.markDeletedBatch(7, { kind: 'personal', userId: 7 }, ['a.txt', 'b.txt', 'a.txt'])

    const update = calls.filter(call => call.text.includes('UPDATE harness.document_catalog AS catalog'))
    const history = calls.filter(call => call.text.includes('INSERT INTO harness.document_history'))
    expect(update).toHaveLength(1)
    expect(update[0]?.values?.[7]).toEqual(['a.txt', 'b.txt'])
    expect(history).toHaveLength(1)
  })
})
