/** Migration preserves registered file and activity identities while a different computer or stale approval is rejected. */
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { expect } from 'vitest'
import type { NodeContentStore } from '../src/node-content-store.ts'
import { NodeContentDocuments } from '../src/node-content-documents.ts'
import { NodeDocumentAuthority } from '../src/node-content-documents-authority.ts'
import { PeerProjectFileGate } from '../src/peer-backup-file-gate.ts'
import { PostgresDocumentCatalogService } from '../src/postgres/document-catalog-service.ts'
import { PostgresDocumentLocations } from '../src/postgres/document-locations.ts'
import type { PostgresRuntimeContext } from '../src/postgres/runtime-context.ts'
import type { RuntimeNodeId } from '../src/runtime-catalog.ts'
import { testConfig } from './test-config.ts'
import { physicalDocumentSource } from './node-content-documents-files.ts'
import { personalDocumentAdminHttp } from './node-content-personal-document-http.ts'
import {
  PERSONAL_DOCUMENT_HISTORY_PREFIX,
  PERSONAL_DOCUMENT_HISTORY_SUFFIX,
} from '../src/personal-document-history-restore.ts'
import { transaction } from '../src/postgres/database.ts'

export async function verifyPersonalDocumentHistory(
  context: PostgresRuntimeContext,
  store: NodeContentStore,
  directory: string,
) {
  const db = context.pool,
    org = context.organizationId,
    node = context.nodeId as RuntimeNodeId
  const cfg = testConfig(join(directory, 'doc-migration'))
  const addUser = async (role: 'admin' | 'member') => {
    const u = (
      await db.query(
        "INSERT INTO harness.users(organization_id,username,display_name,home_path) VALUES($1,$2,'Document tester',$3) RETURNING id,public_id::float8 n",
        [org, randomUUID(), join(directory, randomUUID())],
      )
    ).rows[0]!
    await db.query("INSERT INTO harness.memberships(organization_id,user_id,role,status) VALUES($1,$2,$3,'active')", [
      org,
      u.id,
      role,
    ])
    await db.query("INSERT INTO harness.password_credentials(user_id,password_hash,must_change_password) VALUES($1,'fixture',false)", [u.id])
    await db.query('INSERT INTO harness.node_user_accounts(organization_id,node_id,user_id,home_path) VALUES($1,$2,$3,$4)', [
      org,
      node,
      u.id,
      join(directory, u.id),
    ])
    await db.query(
      'INSERT INTO harness.computer_use_permissions(organization_id,node_id,user_id,enabled) VALUES($1,$2,$3,true)',
      [org, node, u.id],
    )
    return u
  }
  const admin = await addUser('admin'),
    owner = await addUser('member'),
    fresh = await addUser('member')
  const history = await physicalDocumentSource(owner.n),
    empty = await physicalDocumentSource(fresh.n)
  const scopes = new PostgresDocumentLocations(context, cfg.runtimeCatalog, node)
  const legacy = new PostgresDocumentCatalogService(context, 30, node)
  const gate = new PeerProjectFileGate(directory, 'personal-document-handoff')
  const docs = new NodeContentDocuments(new NodeDocumentAuthority(context, scopes, store), undefined, {
    inspect: async (user, _maxRows, cursor) => {
      expect(user).toBe(owner.n)
      return history.inspect(cursor)
    },
    gate,
  })
  const service = new PostgresDocumentCatalogService(context, 30, node, docs)
  const choices = { nodeId: node, maxRows: 4096, maxBytes: 4 << 20 }
  const http = await personalDocumentAdminHttp(context, cfg, service, owner.n)
  const target = 'dshNode=' + node
  try {
    await service.publishNewPersonalRoot(fresh.n, empty.inspect)
    expect((await docs.authority.placement({ kind: 'personal', userId: fresh.n }))?.rootId).toBe(empty.rootId)
    const identity = await history.publish(legacy)
    await service.publishNewPersonalRoot(owner.n, history.inspect)
    expect(await docs.authority.placement({ kind: 'personal', userId: owner.n })).toBeNull()
    await expect(docs.personalHistory.preflight(owner.n, owner.n, choices)).rejects.toThrow()
    await expect(docs.personalHistory.preflight(admin.n, owner.n, { ...choices, nodeId: randomUUID() })).rejects.toThrow()
    let selected = await docs.personalHistory.preflight(admin.n, owner.n, choices)
    expect(selected).toMatchObject({ ready: true, counts: { fileCount: 1, transferCount: 0 }, rootId: history.rootId })
    const approval = () => ({
      ...choices,
      rootId: selected.rootId,
      catalogDigest: selected.catalogDigest,
      physicalDigest: selected.physicalDigest,
    })
    expect((await http.request(target)).value).toMatchObject({ ready: true, rootId: history.rootId })
    expect((await http.request(target, undefined, true)).status).toBe(403)
    for (const query of ['', target + '&dshRuntime=' + randomUUID()]) expect((await http.request(query)).status).toBe(409)
    expect((await http.request(target + '&' + target)).status).toBe(400)
    expect((await http.request(target + '&maxRows=0')).status).toBe(400)
    expect((await http.request(target, { ...approval(), nodeId: randomUUID() })).status).toBe(409)
    expect((await http.request(target, { nodeId: node })).status).toBe(400)
    await gate.admit(owner.n, async () => {
      expect(await http.request(target, approval())).toMatchObject({
        status: 409,
        value: { error: 'DOCUMENT_MIGRATION_BUSY' },
      })
    })
    const row = (
      await db.query(
        'SELECT id FROM harness.document_catalog WHERE organization_id=$1 AND node_id=$2 AND runtime_incarnation_id=$3',
        [org, node, identity.incarnationId],
      )
    ).rows[0]!
    await db.query(
      "INSERT INTO harness.document_history(organization_id,catalog_id,actor_user_id,event_kind,detail) VALUES($1,$2,$3,'denied',jsonb_build_object('synthetic',repeat('x',2048)))",
      [org, row.id, admin.id],
    )
    await expect(docs.personalHistory.publish(admin.n, owner.n, approval())).rejects.toThrow()
    expect((await http.request(target + '&maxBytes=1024')).value).toMatchObject({ ready: false, blockers: ['byte-budget'] })
    selected = await docs.personalHistory.preflight(admin.n, owner.n, choices)
    expect(await http.request(target, approval())).toMatchObject({
      status: 200,
      value: { rootId: history.rootId, published: true },
    })
    const detail = await service.detail(row.id, admin.n)
    expect(detail?.document.identity).toMatchObject({ incarnationId: identity.incarnationId, revision: identity.revision })
    expect(detail?.history.some((event) => event.eventKind === 'denied')).toBe(true)
    expect((await db.query('SELECT id FROM harness.document_catalog WHERE id=$1', [row.id])).rowCount).toBe(1)
    expect((await db.query('SELECT id FROM harness.legacy_document_catalog WHERE id=$1', [row.id])).rowCount).toBe(0)
    await expect(db.query('DELETE FROM harness.document_catalog WHERE id=$1', [row.id])).rejects.toThrow()
    const replay = (mutation?: string) =>
      transaction(db, async (tx) => {
        await tx.query(PERSONAL_DOCUMENT_HISTORY_PREFIX)
        if (mutation) await tx.query(mutation, [org, node, owner.id])
        await tx.query(PERSONAL_DOCUMENT_HISTORY_SUFFIX)
      })
    await replay()
    await expect(
      replay(
        'UPDATE harness.computer_use_permissions SET enabled=false WHERE organization_id=$1 AND node_id=$2 AND user_id=$3',
      ),
    ).rejects.toThrow('authority differs')
    await expect(
      replay('DELETE FROM harness.personal_document_imports WHERE organization_id=$1 AND node_id=$2 AND user_id=$3'),
    ).rejects.toThrow()
    await expect(
      transaction(db, async (tx) => {
        await tx.query(PERSONAL_DOCUMENT_HISTORY_PREFIX)
        await tx.query("SET LOCAL session_replication_role='replica'")
        await tx.query(
          "UPDATE harness.document_history SET detail='{}'::jsonb WHERE organization_id=$1 AND catalog_id=$2 AND event_kind='denied'",
          [org, row.id],
        )
        await tx.query("SET LOCAL session_replication_role='origin'")
        await tx.query(PERSONAL_DOCUMENT_HISTORY_SUFFIX)
      }),
    ).rejects.toThrow('predecessor or authority differs')
    expect(
      (
        await db.query(
          'SELECT enabled FROM harness.computer_use_permissions WHERE organization_id=$1 AND node_id=$2 AND user_id=$3',
          [org, node, owner.id],
        )
      ).rows[0]?.enabled,
    ).toBe(true)
    await history.lifecycle(service, admin.n, row.id)
  } finally {
    await Promise.all([http.close(), history.dispose(), empty.dispose()])
  }
}
