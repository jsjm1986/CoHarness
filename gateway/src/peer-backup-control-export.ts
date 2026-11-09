/** Read-only organization recovery inventory. Only listed governance columns enter the encrypted payload. */
import { createHash } from 'node:crypto'
import { open, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { Pool } from 'pg'
import { transaction } from './postgres/database.ts'
import type { PeerBackupBinding, PeerBackupExporter, PeerCapture } from './peer-backup-restic.ts'
import { PeerBackupError } from './peer-backup-repository.ts'

export { validatePeerControl } from './peer-backup-control-validation.ts'
import { controlCoverageGaps, names, projections, validatePeerControl, type Limits } from './peer-backup-control-validation.ts'

/** Capture account, allocation and policy references without copying ordinary session bodies or old active credentials. */
export class PeerControlExporter implements PeerBackupExporter {
  constructor(
    private readonly control: Pool,
    private readonly limits: Limits,
  ) {}

  async capture(binding: PeerBackupBinding, directory: string, signal: AbortSignal): Promise<PeerCapture> {
    if (binding.scopeId !== binding.organizationId) throw new PeerBackupError(409, 'peer-backup/cross-scope-row')
    return transaction(
      this.control,
      async (db) => {
        await db.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY')
        const coordinate = (
          await db.query<{ revision: string; watermark: string; time: Date }>(
            `SELECT revision::text,
        pg_snapshot_xmax(pg_current_snapshot())::text watermark, transaction_timestamp() time FROM harness.deployment_topology
        WHERE organization_id=$1 AND primary_node_id=$2 AND enabled AND revision>0`,
            [binding.organizationId, binding.sourceNodeId],
          )
        ).rows[0]
        if (!coordinate) throw new PeerBackupError(409, 'peer-backup/space-placement-changed')
        const file = await open(join(directory, 'governance.jsonl'), 'wx', 0o600)
        const hash = createHash('sha256')
        let rows = 0,
          bytes = 0
        try {
          for (const table of names) {
            const org = table === 'organizations' ? 'id' : 'organization_id'
            const relation =
              table === 'project_source_retirement_evidence'
                ? '(SELECT e.ctid,r.organization_id,e.* FROM harness.project_source_retirement_evidence e JOIN harness.project_source_retirement_reviews r ON r.id=e.review_id) custody'
                : 'harness.' + table
            await db.query(
              `DECLARE peer_control NO SCROLL CURSOR FOR SELECT CASE WHEN octet_length(row_to_json(r)::text)<=$2
            THEN row_to_json(r)::text END body FROM (SELECT ${projections[table]} FROM ${relation} WHERE ${org}=$1 ORDER BY ctid) r`,
              [binding.organizationId, Math.min(8 << 20, this.limits.maxBytes)],
            )
            for (;;) {
              signal.throwIfAborted()
              const result = await db.query<{ body: string | null }>('FETCH FORWARD 8 FROM peer_control')
              if (!result.rowCount) break
              for (const { body } of result.rows) {
                if (body === null) throw new PeerBackupError(507, 'peer-backup/export-budget')
                const line = '{"table":' + JSON.stringify(table) + ',"row":' + body + '}\n'
                bytes += Buffer.byteLength(line)
                if (++rows > this.limits.maxRows || bytes > this.limits.maxBytes)
                  throw new PeerBackupError(507, 'peer-backup/export-budget')
                await file.writeFile(line)
                hash.update(line)
              }
            }
            await db.query('CLOSE peer_control')
          }
          await file.sync()
        } finally {
          await file.close()
        }
        await writeFile(
          join(directory, 'governance.json'),
          JSON.stringify({
            version: 2,
            rows,
            sha256: hash.digest('hex'),
            topologyRevision: coordinate.revision,
            watermark: coordinate.watermark,
          }),
          { flag: 'wx', mode: 0o600 },
        )
        return {
          version: 1,
          organizationId: binding.organizationId,
          sourceNodeId: binding.sourceNodeId,
          scopeId: binding.scopeId,
          writerEpoch: coordinate.revision,
          watermark: coordinate.watermark,
          capturedAt: coordinate.time.toISOString(),
          coveredCount: names.length,
          gaps: [...controlCoverageGaps],
        }
      },
      signal,
    )
  }

  validate(binding: PeerBackupBinding, capture: PeerCapture, directory: string, signal: AbortSignal) {
    return validatePeerControl(binding, capture, directory, signal, this.limits)
  }
}
