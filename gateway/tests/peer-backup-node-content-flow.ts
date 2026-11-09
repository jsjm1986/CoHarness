/** Verify a populated, physically attested project database under the existing node-volume integration fixture. */
import { randomUUID } from 'node:crypto'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { expect } from 'vitest'
import type { Queryable } from '../src/postgres/database.ts'
import type { NodeContentBinding, NodeContentStore } from '../src/node-content-store.ts'
import { PeerProjectExporter, validatePeerProject } from '../src/peer-backup-project-export.ts'

/** Assert a scope-specific point retains the assembled project's Session and workspace records. */
export async function verifyProjectRecoveryPoint(
  control: Queryable,
  store: NodeContentStore,
  space: NodeContentBinding,
  root: string,
) {
  const dir = await mkdtemp(join(root, 'peer-project-point-'))
  const binding = {
    policyId: randomUUID(),
    organizationId: space.organizationId,
    scopeId: space.projectId,
    revision: 1,
    sourceNodeId: space.nodeId,
    targetNodeId: randomUUID(),
  }
  const limits = { maxBytes: 8 << 20, maxRows: 10000 }
  const exporter = new PeerProjectExporter({ control, store, ...limits })
  try {
    const capture = await exporter.capture(binding, dir, new AbortController().signal)
    expect(capture.gaps).toEqual(['workspace-and-plugin-files:no-consistent-snapshot'])
    await validatePeerProject(binding, capture, dir, new AbortController().signal, limits)
    const inventory = JSON.parse(await readFile(join(dir, 'project', 'inventory.json'), 'utf8')) as {
      tables: Array<{ name: string; rows: number }>
    }
    for (const table of ['spaces', 'workspace_catalog', 'conversation_sessions', 'conversation_events']) {
      expect(inventory.tables.find((row) => row.name === table)?.rows).toBeGreaterThan(0)
    }
    expect(inventory.tables.map((row) => row.name)).toEqual(
      expect.arrayContaining([
        'execution_sessions',
        'project_journal',
        'project_journal_materials',
        'project_journal_requests',
        'project_journal_state',
      ]),
    )
    await expect(
      validatePeerProject({ ...binding, scopeId: randomUUID() }, capture, dir, new AbortController().signal, limits),
    ).rejects.toMatchObject({ code: 'peer-backup/invalid-export' })
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}
