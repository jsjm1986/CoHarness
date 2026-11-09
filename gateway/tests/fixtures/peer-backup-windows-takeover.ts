/** The Windows side of an explicitly approved, online project writer handoff between two disposable servers. */
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { basename, join, resolve } from 'node:path'
import { mkdir, readFile, realpath, writeFile } from 'node:fs/promises'
import { Pool } from 'pg'
import { withWindowsProjectDatabase } from './peer-backup-windows-physical.ts'
import { waitExchange, writeExchange, type ReceiverOffer } from '../peer-backup-takeover-cross-source.ts'
import { verifyReplacementDispatch } from '../peer-backup-takeover-dispatch.ts'
import { testConfig } from '../test-config.ts'
import { PeerProjectFileGate } from '../../src/peer-backup-file-gate.ts'
import { PeerBackupGovernance } from '../../src/peer-backup-governance.ts'
import { PeerBackupRepository } from '../../src/peer-backup-repository.ts'
import { PeerBackupRestic } from '../../src/peer-backup-restic.ts'
import { PeerProjectExporter } from '../../src/peer-backup-project-export.ts'
import { PeerProjectRecovery, recoveryBinding } from '../../src/peer-backup-takeover.ts'
import { projectReplacementLayout } from '../../src/peer-backup-takeover-layout.ts'
import { runPeerRecoveryPhase } from '../../src/peer-backup-takeover-worker.ts'
import { resolvePostgresRuntimeContext } from '../../src/postgres/runtime-context.ts'

async function run(input: string) {
  const dir = await realpath(input)
  const id = basename(dir).slice('hgw-peer-online-'.length)
  assert.equal(basename(dir), 'hgw-peer-online-' + id)
  assert.match(id, /^[a-f0-9-]{36}$/u)
  assert.equal(await readFile(join(dir, 'fixture-owner'), 'utf8'), id)
  const offer: ReceiverOffer & { fixture: string; controlPort: number; dbPassword: string } = JSON.parse(
    await readFile(join(dir, 'offer.json'), 'utf8'),
  )
  assert.equal(offer.fixture, id)
  assert.match(offer.organizationSlug, /^takeover-[a-f0-9-]{36}$/u)
  assert.ok(Number.isSafeInteger(offer.controlPort) && offer.controlPort > 1024 && offer.controlPort <= 65535)
  const volumeRoot = resolve(dir, '../..')
  const control = new Pool({
    host: '127.0.0.1',
    port: offer.controlPort,
    database: 'hgw_governance_test',
    user: 'postgres',
    password: offer.dbPassword,
    max: 5,
    connectionTimeoutMillis: 15000,
  })
  const cfg = testConfig(join(dir, 'gateway-state'))
  const signal = AbortSignal.timeout(1000000)
  const start = performance.now()
  try {
    assert.equal((await control.query('SELECT current_database() name')).rows[0].name, 'hgw_governance_test')
    const ctx = await resolvePostgresRuntimeContext(control, offer.organizationSlug, 'destination')
    assert.equal(ctx.organizationId, offer.policy.organizationId)
    assert.equal(ctx.nodeId, offer.policy.targetNodeId)
    for (const path of [cfg.projectRuntimesRoot, cfg.projectsRoot, cfg.userProjectsRoot, cfg.stateRoot])
      await mkdir(path, { recursive: true })
    await withWindowsProjectDatabase(
      volumeRoot,
      { organizationId: ctx.organizationId, nodeId: ctx.nodeId, volumeId: offer.targetVolume },
      async (store, postgresVersion) => {
        await store.registerVolume(control)
        const gov = new PeerBackupGovernance(ctx)
        const repository = await PeerBackupRepository.open({
          directory: join(dir, 'ciphertext'),
          nodeId: ctx.nodeId,
          capacityBytes: 64 << 20,
          objectLimit: 256,
          maxObjectBytes: 32 << 20,
          concurrency: 4,
          grant: (policy, user, token) => gov.grant(policy, user, token),
        })
        const server = createServer((req, res) => {
          void repository
            .handle(req, res)
            .then((handled) => {
              if (!handled) res.writeHead(404).end()
            })
            .catch(() => {
              if (!res.headersSent) res.writeHead(503)
              res.end()
            })
        })
        try {
          await new Promise<void>((ok, reject) => {
            server.once('error', reject)
            server.listen(0, '127.0.0.1', ok)
          })
          const port = (server.address() as AddressInfo).port
          const origin = 'http://127.0.0.1:' + port
          await writeExchange(join(dir, 'receiver.json'), { port })
          const { pointId } = await waitExchange<{ pointId: string }>(join(dir, 'captured.json'), signal)
          const limits = { maxBytes: 32 << 20, maxRows: 5000, reserveBytes: 1 << 20 }
          const exporter = new PeerProjectExporter({ control, store, ...limits })
          const passwordFile = join(dir, 'recovery-password')
          await writeFile(passwordFile, offer.password, { flag: 'wx', mode: 0o600 })
          const engine = new PeerBackupRestic({
            executable: join(dir, 'restic.exe'),
            stagingDirectory: join(dir, 'staging'),
            uploadKiBps: 8192,
            downloadKiBps: 8192,
            timeoutMs: 360000,
            maxRestoreBytes: limits.maxBytes,
            reserveBytes: limits.reserveBytes,
          })
          const drill = (active: AbortSignal = signal) =>
            engine.drill(
              offer.policy,
              pointId,
              { origin, user: offer.policy.sourceNodeId, token: offer.recoveryToken, passwordFile },
              exporter,
              active,
            )
          const job = await gov.claim()
          assert.equal(job?.kind, 'drill')
          assert.equal(job?.pointId, pointId)
          const first = await gov.withLease(job!, signal, (active) => drill(active))
          try {
            assert.equal(first.point.gapCount, 0)
            await gov.finish(job!, { recoveryMs: first.recoveryMs })
          } finally {
            await first.dispose()
          }
          await writeExchange(join(dir, 'rehearsed.json'), { pointId })
          const { id: operation } = await waitExchange<{ id: string }>(join(dir, 'operation.json'), signal)
          const service = new PeerProjectRecovery(
            ctx,
            store,
            limits,
            cfg.instancePortBase,
            undefined,
            new PeerProjectFileGate(cfg.stateRoot),
          )
          const initial = await service.get(operation)
          const retired = new PeerProjectFileGate(join(dir, 'previous-gateway-state'))
          await retired.retire(initial.publicId, operation, async () => true)
          const previous = new PeerProjectRecovery(ctx, store, limits, cfg.instancePortBase, undefined, retired)
          await assert.rejects(previous.confirmTarget(operation, signal), { code: 'peer-backup/project-files-retired' })
          assert.equal((await service.get(operation)).phase, 'prepared')
          const phase = () =>
            runPeerRecoveryPhase(
              {
                service,
                workGate: new PeerProjectFileGate(cfg.stateRoot,'peer-project-recovery-work'),
                volume: store,
                instances: {
                  async withStopped() {
                    throw new Error('The target cannot retire the source.')
                  },
                },
                limits,
                layout: (op) => projectReplacementLayout(cfg, ctx, op),
                drill: (_op, active) => drill(active),
              },
              signal,
            )
          await phase()
          const op = await service.get(operation)
          if (op.phase !== 'target-ready')
            throw new Error(
              'Windows candidate phase ' +
                op.phase +
                ' ' +
                ((await control.query('SELECT last_error FROM harness.project_recovery_operations WHERE id=$1', [operation]))
                  .rows[0]?.last_error ?? ''),
            )
          const binding = recoveryBinding(op, 'target')
          await assert.rejects(
            store.write(binding, async () => true),
            { code: 'node-content/unavailable' },
          )
          await writeExchange(join(dir, 'candidate.json'), { id: operation, candidateRefusedWrite: true })
          assert.equal((await waitExchange<{ id: string }>(join(dir, 'switched.json'), signal)).id, operation)
          await phase()
          const location = await store.read(
            binding,
            async (tx) =>
              (
                await tx.query(
                  `SELECT d.root_id,s.root_path,a.path storage FROM node_content.spaces s
          JOIN node_content.document_roots d USING (organization_id,runtime_id) JOIN node_content.project_file_anchors a USING(organization_id,runtime_id)
          WHERE s.organization_id=$1 AND s.runtime_id=$2 AND a.owner='storage'`,
                  [ctx.organizationId, binding.runtimeId],
                )
              ).rows[0],
          )
          assert.equal(location?.root_id, offer.rootId)
          assert.equal(await readFile(join(location.root_path, 'documents', 'report.txt'), 'utf8'), 'bytes to recover\n')
          const events = await verifyReplacementDispatch(
            store,
            binding,
            offer.session,
            offer.previousDelivery,
            location.storage,
            resolve(dir, 'packages/schedule/schedule/lib/types/runtime.js'),
          )
          assert.equal(events, 2)
          const writable = await store.write(binding, async () => true)
          await writeExchange(join(dir, 'delivered.json'), {
            synthetic: true,
            pointId,
            operation,
            writable,
            postgresVersion,
            epoch: binding.writerEpoch,
            originalReminderRetained: true,
            newReminderDeliveries: events - 1,
            workspaceAndDocuments: true,
            windowsMs: Math.round(performance.now() - start),
          })
        } finally {
          server.closeAllConnections()
          await new Promise<void>((done) => server.close(() => done()))
          await repository.close()
        }
      },
    )
  } finally {
    await control.end()
    await writeExchange(join(dir, 'target-finished.json'), { closed: true })
  }
}
void run(process.argv[2]!).catch(async (error) => {
  const directory = process.argv[2]
  const known = error instanceof Error && /^[\w.\- :]+$/u.test(error.message) ? error.message : 'qualification-failed'
  if (directory && basename(directory).startsWith('hgw-peer-online-'))
    await writeExchange(join(directory, 'failed.json'), { failed: known }).catch(() => {})
  process.stderr.write(known + '\n')
  process.exitCode = 1
})
