/** Real local PostgreSQL document roots and live organization permissions in a disposable node-volume fixture. */
import { randomUUID } from 'node:crypto'
import type { Pool } from 'pg'
import { expect } from 'vitest'
import { physicalDocumentSource } from './node-content-documents-files.ts'
import { NodeDocumentAuthority } from '../src/node-content-documents-authority.ts'
import { NodeContentDocuments } from '../src/node-content-documents.ts'
import { NODE_DOCUMENTS_RESTORE_PREFIX, NODE_DOCUMENTS_RESTORE_SUFFIX } from '../src/node-documents-restore-guard.ts'
import type { NodeContentBinding, NodeContentStore } from '../src/node-content-store.ts'
import { PostgresDocumentCatalogService } from '../src/postgres/document-catalog-service.ts'
import { PostgresDocumentLocations } from '../src/postgres/document-locations.ts'
import { resolvePostgresRuntimeContext } from '../src/postgres/runtime-context.ts'
import { transaction } from '../src/postgres/database.ts'
import type { RuntimeNodeId } from '../src/runtime-catalog.ts'

/** Restrict all cleanup, including the test-only publication guard bypass, to this private fixture's generated roots. */
export async function verifyPublishedDocuments(
  control: Pool,
  store: Pick<NodeContentStore, 'read' | 'write' | 'readVolume' | 'writeVolume'>,
  b: NodeContentBinding,
) {
  const db = (await control.query('SELECT current_database() db')).rows[0].db
  if (db !== 'hgw_governance_test' && !/^hgw_doc_[a-f0-9]+_test$/u.test(db))
    throw new Error('Isolated document database required')
  const identity = (
    await control.query(
      `SELECT o.slug,n.name FROM harness.organizations o JOIN harness.compute_nodes n ON n.organization_id=o.id
    WHERE o.id=$1 AND n.id=$2`,
      [b.organizationId, b.nodeId],
    )
  ).rows[0]
  const context = await resolvePostgresRuntimeContext(control, identity.slug, identity.name)
  const node = b.nodeId as RuntimeNodeId
  const locations = new PostgresDocumentLocations(context, { pageSize: 40, maxBytes: 65536 }, node)
  const authority = new NodeDocumentAuthority(context, locations, store)
  const documents = new NodeContentDocuments(authority)
  const service = new PostgresDocumentCatalogService(context, 30, node, documents)
  const users = (
    await control.query<{ id: string; publicId: number }>(
      `SELECT u.id,u.public_id::float8 "publicId" FROM harness.users u
    JOIN harness.memberships m ON m.organization_id=u.organization_id AND m.user_id=u.id
    WHERE u.organization_id=$1 AND m.status='active' AND u.status='active' AND u.deleted_at IS NULL ORDER BY u.public_id LIMIT 2`,
      [b.organizationId],
    )
  ).rows
  expect(users).toHaveLength(2)
  const resources:Array<Awaited<ReturnType<typeof physicalDocumentSource>>>=[]
  const roots: string[] = [],
    scopes: string[] = []
  try {
    for (const user of users) {
      const physical=await physicalDocumentSource(user.publicId)
      resources.push(physical)
      const root=physical.rootId
      roots.push(root)
      scopes.push(user.id)
      await control.query(
        `INSERT INTO harness.node_user_accounts(organization_id,node_id,user_id,home_path)
        VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING`,
        [b.organizationId, b.nodeId, user.id, '/synthetic/documents/' + user.id],
      )
      await store.writeVolume(async tx => {
        await tx.query(
          `INSERT INTO node_content.document_roots
        (organization_id,node_id,scope_kind,scope_id,root_id,volume_id,writer_epoch) VALUES($1,$2,'personal',$3,$4,$5,1)`,
          [b.organizationId, b.nodeId, user.id, root, b.volumeId],
        )
      })
      await control.query(
        `INSERT INTO harness.document_scope_placement(organization_id,node_id,scope_kind,scope_id,root_id,volume_id,writer_epoch,publication_revision)
        VALUES($1,$2,'personal',$3,$4,$5,1,0)`,
        [b.organizationId, b.nodeId, user.id, root, b.volumeId],
      )
      const target={kind:'personal' as const,userId:user.publicId}
      expect(await service.projectionCursor(user.publicId,target,root)).toEqual({sequence:0,ordinal:0})
      const {incarnationId:id,revision}=await physical.publish(service)
      const published = (await authority.placement(target))!
      expect((await documents.list(published, user.publicId, { limit: 5 })).documents[0]).toMatchObject({
        docId: 'same-name.txt',
        bytes: user.publicId,
      })
      await expect(
        documents.list(published, users.find(other => other.id !== user.id)!.publicId, { limit: 5 }),
      ).rejects.toMatchObject({ status: 403 })
      expect(
        (
          await service.authorize({
            actorUserId: user.publicId,
            scope: target,
            action: 'move',
            documents: [{ docId: 'same-name.txt', incarnationId: id, revision }],
          })
        ).selections,
      ).toHaveLength(1)
      await expect(
        service.authorize({
          actorUserId: user.publicId,
          scope: target,
          action: 'move',
          documents: [{ docId: 'same-name.txt', incarnationId: randomUUID(), revision: 1 }],
        }),
      ).rejects.toMatchObject({ status: 409 })
      const missing = new NodeContentDocuments(new NodeDocumentAuthority(context, locations))
      await expect(missing.list(published, user.publicId, { limit: 5 })).rejects.toMatchObject({ status: 503 })
      if(user.id===users[0]!.id){
        const catalogId=(await documents.list(published,user.publicId,{limit:5})).documents[0]!.catalogId
        const role=(await control.query('SELECT role FROM harness.memberships WHERE organization_id=$1 AND user_id=$2',[b.organizationId,user.id])).rows[0].role
        await control.query("UPDATE harness.memberships SET role='admin' WHERE organization_id=$1 AND user_id=$2",[b.organizationId,user.id])
        try {await physical.lifecycle(service,user.publicId,catalogId)}
        finally{await control.query('UPDATE harness.memberships SET role=$3 WHERE organization_id=$1 AND user_id=$2',[b.organizationId,user.id,role])}
      }
      await expect(
        control.query(
          `INSERT INTO harness.document_projection_checkpoints(node_id,organization_id,root_id,scope_kind,scope_user_id,sequence,ordinal)
        VALUES($1,$2,$3,'personal',$4,0,0)`,
          [node, b.organizationId, root, user.id],
        ),
      ).rejects.toThrow(/writer has moved|owning computer/u)
    }
    expect(
      (
        await control.query('SELECT FROM harness.document_catalog WHERE organization_id=$1 AND name=$2', [
          b.organizationId,
          'same-name.txt',
        ])
      ).rows,
    ).toEqual([])
    const user = users[0]!,
      root = (await authority.placement({ kind: 'personal', userId: user.publicId }))!
    await control.query(
      'UPDATE harness.computer_use_permissions SET enabled=false WHERE organization_id=$1 AND node_id=$2 AND user_id=$3',
      [b.organizationId, b.nodeId, user.id],
    )
    try {
      await expect(documents.list(root, user.publicId, { limit: 5 })).rejects.toMatchObject({ status: 403 })
    } finally {
      await control.query(
        'UPDATE harness.computer_use_permissions SET enabled=true WHERE organization_id=$1 AND node_id=$2 AND user_id=$3',
        [b.organizationId, b.nodeId, user.id],
      )
    }
    await expect(
      transaction(control, async tx => {
        await tx.query(NODE_DOCUMENTS_RESTORE_PREFIX)
        await tx.query('UPDATE harness.users SET status=$1 WHERE id=$2', ['disabled', user.id])
        await tx.query(NODE_DOCUMENTS_RESTORE_SUFFIX)
      }),
    ).rejects.toThrow(/authority differs/u)
    expect((await control.query('SELECT status FROM harness.users WHERE id=$1', [user.id])).rows[0].status).toBe('active')
  } finally {
    for(const resource of resources)await resource.dispose()
    await store.writeVolume(async tx => {
      for (const table of ['document_receipts', 'document_events', 'document_entries', 'document_roots']) {
        await tx.query('DELETE FROM node_content.' + table + ' WHERE organization_id=$1 AND root_id=ANY($2::uuid[])', [
          b.organizationId,
          roots,
        ])
      }
    })
    await transaction(control, async tx => {
      await tx.query('SET LOCAL session_replication_role=replica')
      await tx.query('DELETE FROM harness.document_scope_placement WHERE organization_id=$1 AND root_id=ANY($2::uuid[])', [
        b.organizationId,
        roots,
      ])
      await tx.query(
        "DELETE FROM harness.document_scope_writers WHERE organization_id=$1 AND node_id=$2 AND scope_kind='personal' AND scope_id=ANY($3::uuid[])",
        [b.organizationId, b.nodeId, scopes],
      )
    })
  }
}
