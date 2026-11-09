/** Two independent PostgreSQL content volumes, normal peer REST/restic and a real kernel-owned Gateway stop confirmation. */
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { createServer } from 'node:http'
import { lstat, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join, resolve } from 'node:path'
import type { AddressInfo } from 'node:net'
import { LocalUserDocFs } from '@deepseek-ai/dsh-userdoc-local'
import { describe, expect, it } from 'vitest'
import { createPostgresPool, runMigrations, transaction } from '../src/postgres/database.ts'
import { resolvePostgresRuntimeContext } from '../src/postgres/runtime-context.ts'
import { PostgresUserService } from '../src/postgres/user-service.ts'
import { PostgresNodeAccessService } from '../src/postgres/node-access-service.ts'
import { PostgresDeploymentTopology } from '../src/deployment-topology.ts'
import type { NodeCredential } from '../src/node-access.ts'
import { NodeContentStore } from '../src/node-content-store.ts'
import { migrateNodeContent } from '../src/node-content-migrations.ts'
import { PeerBackupGovernance } from '../src/peer-backup-governance.ts'
import { PeerBackupRestic } from '../src/peer-backup-restic.ts'
import { PeerBackupRepository, PEER_REPOSITORY_PREFIX } from '../src/peer-backup-repository.ts'
import { PeerProjectExporter } from '../src/peer-backup-project-export.ts'
import type { PeerFileRootMap } from '../src/peer-snapshot-roots.ts'
import { verifyReplacementDispatch } from './peer-backup-takeover-dispatch.ts'
import { runNormalRecovery } from './peer-backup-takeover-http.ts'
import { prepareCrossReceiver, finishCrossReceiver, writeExchange } from './peer-backup-takeover-cross-source.ts'
import { PeerProjectRecovery, recoveryBinding } from '../src/peer-backup-takeover.ts'
import { PeerProjectFileGate } from '../src/peer-backup-file-gate.ts'
import { documentIdentityLocations } from '../src/document-storage.ts'
import { latestPeerFileWitness } from '../src/peer-backup-file-digest.ts'
import { stagePeerProject } from '../src/peer-backup-takeover-stage.ts'
import { stagePeerProjectFiles } from '../src/peer-backup-takeover-files.ts'
import { readProjectScheduleWitness } from '../src/peer-backup-takeover-schedule.ts'
import { PostgresInstanceRepository } from '../src/postgres/instance-repository.ts'
import { NodeProjectMetadata } from '../src/node-content-projects.ts'
import { NodeResourceBudget } from '../src/node-resource-budget.ts'
import { GatewayModelBudget } from '../src/gateway-model-budget.ts'
import { InstanceManager } from '../src/instances.ts'
import type { RuntimeId } from '../src/runtime-catalog.ts'
import { testConfig } from './test-config.ts'
import { postgresTestDatabaseUrl } from './postgres-test-database.mjs'

const controlUrl = postgresTestDatabaseUrl(process.env.HGW_TEST_DATABASE_URL)
const contentUrl = postgresTestDatabaseUrl(process.env.HGW_TEST_NODE_CONTENT_DATABASE_URL)
const pgdata = process.env.HGW_TEST_NODE_CONTENT_PGDATA,
  restic = process.env.HGW_TEST_RESTIC
const crossDirectory = process.env.HGW_TEST_PEER_TAKEOVER_EXCHANGE
const hash = (s: string) => createHash('sha256').update(s).digest('hex')
describe.skipIf(!controlUrl || !contentUrl || !pgdata || !restic)('operator-approved replacement project', () => {
  it(
    'restores a real UserDoc and the allocated workspace, fences a genuinely stopped writer, preserves scheduled receipts and resumes only the new epoch',
    async () => {
      const root = await realpath(await mkdtemp(join(tmpdir(), 'hgw-peer-takeover-')))
      const targetUrl = new URL(contentUrl!)
      targetUrl.pathname = '/hgw_replacement_content_test'
      const control = createPostgresPool(controlUrl!, { max: 8 }),
        source = createPostgresPool(contentUrl!, { max: 3 }),
        replacement = createPostgresPool(targetUrl.href, { max: 3 })
      const cfg = testConfig(root, crossDirectory ? { HGW_NODE_AGENT_LEASE_MS: '600000' } : {})
      const signal = AbortSignal.timeout(crossDirectory ? 1050000 : 75000),
        limits = { maxBytes: 32 << 20, maxRows: 5000, reserveBytes: 1 << 20 }
      let closeRepo: (() => Promise<void>) | undefined,
        closeOwner: (() => Promise<void>) | undefined,
        dispose: (() => Promise<void>) | undefined
      const server = createServer()
      let cross: Awaited<ReturnType<typeof prepareCrossReceiver>> | undefined
      try {
        const slug = 'takeover-' + randomUUID()
        await runMigrations(control, resolve(import.meta.dirname, '../deploy/postgres/migrations'))
        const org = (
          await control.query("INSERT INTO harness.organizations(slug,display_name) VALUES($1,'Synthetic') RETURNING id", [
            slug,
          ])
        ).rows[0]!.id
        for (const name of ['source', 'destination'])
          await control.query('INSERT INTO harness.compute_nodes(organization_id,name) VALUES($1,$2)', [org, name])
        const a = await resolvePostgresRuntimeContext(control, slug, 'source'),
          b = await resolvePostgresRuntimeContext(control, slug, 'destination')
        const users = new PostgresUserService(a, cfg)
        const admin = await users.create({
          username: 'restore-admin',
          password: randomUUID(),
          role: 'admin',
        })
        await users.changeOwnPassword(admin.id, randomUUID())
        const user = (
          await control.query('SELECT id FROM harness.users WHERE organization_id=$1 AND public_id=$2', [org, admin.id])
        ).rows[0]!.id
        await control.query(
          'INSERT INTO harness.computer_use_permissions(organization_id,node_id,user_id,enabled) VALUES($1,$2,$3,true) ON CONFLICT DO NOTHING',
          [org, b.nodeId, user],
        )
        const topo = new PostgresDeploymentTopology(a, {
          legacyForwarding: false,
          refreshAfterMs: 30000,
          pageSize: 10,
          maxBytes: 65536,
          allowedOrigins: ['https://source.test'],
        })
        await topo.save(admin, {
          revision: (await topo.read()).revision,
          enabled: true,
          primaryOrigin: 'https://source.test',
        })
        const access = new PostgresNodeAccessService(a, cfg.nodeAccess, cfg.runtimeCatalog)
        const ticket = await access.issue(admin, { requestId: randomUUID(), nodeId: b.nodeId }),
          credential = ('dsh_node_' + randomBytes(32).toString('base64url')) as NodeCredential
        await access.enroll(ticket.token, {
          protocolVersion: 1,
          platform: crossDirectory ? 'win32' : 'linux',
          architecture: 'x64',
          credential,
        })
        await access.connect(credential, { connectionId: randomUUID(), executionReady: true })
        const options = [
          { pool: source, nodeId: a.nodeId },
          { pool: replacement, nodeId: b.nodeId },
        ].map((e) => ({ ...e, organizationId: org, volumeId: randomUUID(), dataDirectory: pgdata!, proofTimeoutMs: 5000 }))
        const stores = []
        for (const option of crossDirectory ? options.slice(0, 1) : options) {
          await migrateNodeContent(option, resolve(import.meta.dirname, '../deploy/node-content/migrations'))
          const store = await NodeContentStore.open(option)
          await store.registerVolume(control)
          stores.push(store)
        }
        const [old, next] = stores as [NodeContentStore, NodeContentStore]
        const workspace = join(root, 'source-workspace'),
          home = join(root, 'source-runtime', 'dsh'),
          storage = join(home, 'storages')
        for (const path of [workspace, storage, join(workspace, 'documents'), cfg.stateRoot])
          await mkdir(path, { recursive: true, mode: 0o700 })
        const prospective = Number(
          (await control.query('SELECT coalesce(max(public_id),0)+1 n FROM harness.projects')).rows[0].n,
        )
        const docs = await documentIdentityLocations(cfg, workspace, join(workspace, 'documents'), {
          organizationId: org,
          target: { kind: 'project', id: prospective },
          projectionOwner: async () => null,
        })
        const storageOptions = {
          limits: {
            maxFileBytes: 1 << 20,
            maxFilesPerMessage: 4,
            maxMessageBytes: 4 << 20,
            maxInlineTextBytes: 1024,
            upload: { protocol: 'resumable-v1' as const, chunkBytes: 65536, sessionTtlMs: 60000, resumable: true as const },
          },
          upload: {
            chunkBytes: 65536,
            sessionTtlMs: 60000,
            minFreeBytes: 0,
            maxConcurrent: 2,
            cleanupIntervalMs: 60000,
            manifestMaxBytes: 65536,
          },
          sweepIntervalMs: 60000,
          trashRetentionMs: 86400000,
        }
        const doc = new LocalUserDocFs({
          root: docs.root,
          controlRoot: docs.filesRoot,
          identityLocations: docs,
          ...storageOptions,
        })
        let rootId: string
        try {
          await doc.warm()
          await writeFile(join(docs.root, 'report.txt'), 'bytes to recover\n')
          expect((await doc.list()).length).toBe(1)
          rootId = await doc.identities!.rootId()
          const batch = await doc.identities!.projectionChanges(
            { sequence: 0, ordinal: 0 },
            { limit: 20, maxBytes: 1 << 20 },
          )
          await doc.identities!.acknowledgeProjection(batch.head)
        } finally {
          await doc.dispose()
        }
        const project = await transaction(control, async (tx) => {
          const p = (
            await tx.query(
              "INSERT INTO harness.projects(organization_id,name,created_by,owner_user_id) VALUES($1,'safe project',$2,$2) RETURNING id,public_id::float8 n",
              [org, user],
            )
          ).rows[0]!
          await tx.query(
            'INSERT INTO harness.project_mounts(organization_id,project_id,node_id,local_path,canonical_path) VALUES($1,$2,$3,$4,$4)',
            [org, p.id, a.nodeId, 'urn:hgw:project:' + p.id],
          )
          await tx.query(
            "INSERT INTO harness.project_members(organization_id,project_id,user_id,access_mode) VALUES($1,$2,$3,'rw')",
            [org, p.id, user],
          )
          const runtime = (
            await tx.query<{ runtime_id: RuntimeId }>(
              'INSERT INTO harness.instances(organization_id,project_id,assigned_node_id,port) VALUES($1,$2,$3,48201) RETURNING runtime_id',
              [org, p.id, a.nodeId],
            )
          ).rows[0]!.runtime_id
          const binding = await old.stageProject(tx, {
            projectId: p.id,
            runtimeId: runtime,
            name: 'safe project',
            rootPath: workspace,
          })
          await tx.query(
            'INSERT INTO harness.project_content_placement(organization_id,project_id,node_id,runtime_id,volume_id,writer_epoch) VALUES($1,$2,$3,$4,$5,1)',
            [org, p.id, a.nodeId, runtime, binding.volumeId],
          )
          await tx.query(
            "INSERT INTO harness.document_scope_placement(organization_id,node_id,scope_kind,scope_id,root_id,volume_id,project_runtime_id,writer_epoch,publication_revision) VALUES($1,$2,'project',$3,$4,$5,$6,1,1)",
            [org, a.nodeId, p.id, rootId, binding.volumeId, runtime],
          )
          return binding
        })
        const session = randomUUID(),
          message = randomUUID(),
          task = randomUUID(),
          delivered = '2026-01-01T00:00:00.000Z',
          future = '2099-01-01T00:00:00.000Z'
        const waiting = randomUUID()
        const schedule = {
          unit: { name: 'schedule', version: 1 },
          global: null,
          tables: {
            tasks: {
              [task]: {
                sessionId: session,
                record: {
                  id: task,
                  kind: 'every',
                  title: 'Synthetic recurring task',
                  prompt: 'Record the isolated delivery.',
                  everySeconds: 600,
                  scheduledAt: future,
                },
                status: 'active',
                lastDelivery: { scheduledAt: delivered, deliveredAt: delivered, messageId: message },
                deliveryHistory: {
                  earlierRecordsUnavailable: false,
                  records: [{ scheduledAt: delivered, deliveredAt: delivered, messageId: message }],
                },
              },
              [waiting]: {
                sessionId: session,
                status: 'active',
                deliveryHistory: { earlierRecordsUnavailable: false, records: [] },
                record: {
                  id: waiting,
                  kind: 'at',
                  title: 'Unsent task',
                  prompt: 'Deliver this one occurrence.',
                  scheduledAt: '2026-02-02T00:00:00.000Z',
                },
              },
            },
          },
        }
        const saveSchedule = (s: unknown) => writeFile(join(storage, 'schedule.json'), JSON.stringify(s) + '\n')
        await saveSchedule(schedule)
        await source.query(
          "UPDATE node_content.spaces SET publication_state='published',runtime_generation=1 WHERE runtime_id=$1",
          [project.runtimeId],
        )
        await old.write(project, async (tx) => {
          await tx.query(
            "INSERT INTO node_content.document_roots(organization_id,node_id,scope_kind,scope_id,root_id,volume_id,runtime_id,writer_epoch,sequence,ordinal) VALUES($1,$2,'project',$3,$4,$5,$6,1,1,1)",
            [org, a.nodeId, project.projectId, rootId, project.volumeId, project.runtimeId],
          )
          for (const [owner, path] of [
            ['workspace', workspace],
            ['runtime', home],
            ['storage', storage],
          ] as const) {
            const info = await lstat(path, { bigint: true })
            await tx.query('INSERT INTO node_content.project_file_anchors VALUES($1,$2,$3,$4,$5,$5,$6,$7,false)', [
              org,
              project.projectId,
              project.runtimeId,
              owner,
              path,
              String(info.dev),
              String(info.ino),
            ])
          }
          await tx.query(
            "INSERT INTO node_content.conversation_sessions(organization_id,runtime_id,id,creator_user_id,project_id,root_session_id,visibility,session_format_version,created_at,updated_at,cwd,next_seq,event_count) VALUES($1,$2,$3,$4,$5,$3,'project',1,now(),now(),$6,1,1)",
            [org, project.runtimeId, session, user, project.projectId, workspace],
          )
          await tx.query(
            "INSERT INTO node_content.conversation_events(organization_id,runtime_id,session_id,seq,event_type,occurred_at,event,payload_bytes,query_fields) VALUES($1,$2,$3,0,'agent/inbox/spliced',$4,$5,0,'{}')",
            [
              org,
              project.runtimeId,
              session,
              delivered,
              JSON.stringify({
                type: 'agent/inbox/spliced',
                data: { target: 'followup', start: 0, inserted: [{ id: message, source: { kind: 'schedule' } }] },
              }),
            ],
          )
        })
        const witness = await old.read(project, (tx) => readProjectScheduleWitness(tx, project, limits, signal))
        await saveSchedule({ ...schedule, tables: { tasks: {} } })
        await expect(
          old.read(project, (tx) => readProjectScheduleWitness(tx, project, limits, signal)),
        ).rejects.toMatchObject({ code: 'peer-backup/schedule-evidence-incomplete' })
        await saveSchedule(schedule)
        const ga = new PeerBackupGovernance(a),
          gb = new PeerBackupGovernance(b),
          write = randomUUID(),
          read = randomUUID()
        const policy = await ga.configure(admin.id, {
          id: randomUUID(),
          expectedRevision: 0,
          scopeKind: 'project',
          scopeId: project.projectId,
          sourceNodeId: a.nodeId,
          targetNodeId: b.nodeId,
          tier: 'important',
          quotaBytes: 32 << 20,
          enabled: true,
          appendFingerprint: hash(write),
          recoveryFingerprint: hash(read),
        })
        const passwordFile = join(root, 'pass')
        const password = randomUUID()
        await writeFile(passwordFile, password, { mode: 0o600 })
        if (crossDirectory) {
          cross = await prepareCrossReceiver(
            crossDirectory,
            controlUrl!,
            {
              policy,
              targetVolume: options[1]!.volumeId,
              organizationSlug: slug,
              rootId,
              session,
              previousDelivery: message,
              runtimeId: project.runtimeId,
              recoveryToken: read,
              password,
            },
            signal,
          )
        }
        if (!cross) {
          const repository = await PeerBackupRepository.open({
            directory: join(root, 'repository'),
            nodeId: b.nodeId,
            capacityBytes: 64 << 20,
            objectLimit: 256,
            maxObjectBytes: 32 << 20,
            concurrency: 2,
            grant: (id, user, token) => gb.grant(id, user, token),
          })
          closeRepo = () => repository.close()
          server.on('request', (req, res) => {
            void (async () => {
              const [user, token] = Buffer.from((req.headers.authorization ?? '').slice(6), 'base64')
                .toString()
                .split(':')
              if (!req.url?.startsWith(PEER_REPOSITORY_PREFIX) || !user || !token) {
                res.writeHead(403).end()
                return
              }
              await repository.handle(req, res, await gb.grant(policy.policyId, user, token))
            })().catch(() => {
              if (!res.headersSent) res.writeHead(403)
              res.end()
            })
          })
          await new Promise<void>((done) => server.listen(0, '127.0.0.1', done))
        }
        const origin = cross?.origin ?? 'http://127.0.0.1:' + (server.address() as AddressInfo).port
        const engine = new PeerBackupRestic({
          executable: restic!,
          stagingDirectory: join(root, 'encrypted-work'),
          uploadKiBps: 8192,
          downloadKiBps: 8192,
          timeoutMs: cross ? 420000 : 50000,
          maxRestoreBytes: limits.maxBytes,
          reserveBytes: limits.reserveBytes,
        })
        const fileProvider: import('../src/peer-backup-project-export.ts').PeerProjectFileSnapshots = {
          async acquire(b, revision) {
            // The test owns these stationary directories. Native Btrfs and VSS acquisition have separate platform tests.
            const roots: PeerFileRootMap['roots'] = [
              ['workspace', workspace],
              ['runtime-data', storage],
              ['userdoc-public', docs.root],
              ['userdoc-metadata', docs.stateRoot],
              ['userdoc-objects', docs.filesRoot],
            ].map(([role, path]) => ({
              role: role as PeerFileRootMap['roots'][number]['role'],
              owner:
                role === 'workspace'
                  ? 'project-workspace'
                  : role === 'runtime-data'
                    ? 'project-runtime-storage'
                    : 'gateway-documents/' +
                      basename(docs.stateRoot) +
                      '/' +
                      { 'userdoc-public': 'public', 'userdoc-metadata': 'metadata', 'userdoc-objects': 'files' }[role!],
              kind: 'directory',
              logicalRoot: path!,
              snapshotRoot: path!,
            }))
            return {
              revision,
              capturedAt: new Date().toISOString(),
              logicalRoots: {
                version: 1,
                organizationId: org,
                projectId: b.projectId,
                runtimeId: b.runtimeId,
                sourceNodeId: b.nodeId,
                volumeId: b.volumeId,
                writerEpoch: b.writerEpoch,
                revision,
                documentRootId: rootId,
                provider: 'btrfs',
                roots,
              },
              roots: roots.map((r) => ({ owner: r.owner, kind: r.kind, path: r.logicalRoot })),
              gaps: [],
              async release() {},
            }
          },
          async validate() {
            throw new Error('native logical files should be valid offline')
          },
        }
        const exporter = new PeerProjectExporter({ control, store: old, ...limits, files: fileProvider })
        const jobId = await ga.enqueue(admin.id, policy.policyId, 'capture'),
          job = await ga.claim()
        if (!job || job.id !== jobId) throw new Error('Missing capture claim')
        const point = await ga.withLease(job, signal, (active, progress) =>
          engine.backup(policy, { origin, user: a.nodeId, token: write, passwordFile }, exporter, jobId, active, progress),
        )
        expect(point.gapCount).toBe(0)
        await ga.finish(job, { point })
        const projectA = new PeerProjectRecovery(
          a,
          old,
          limits,
          cfg.instancePortBase,
          (op, s) => latestPeerFileWitness(exporter, policy, op, join(root, 'encrypted-work'), s),
          new PeerProjectFileGate(cfg.stateRoot),
        )
        const intent = {
          requestId: randomUUID(),
          pointId: point.pointId,
          policyId: policy.policyId,
          targetNode: b.nodeId,
          targetVolume: options[1]!.volumeId,
        }
        await expect(projectA.request(admin.id, intent)).rejects.toMatchObject({
          code: 'peer-backup/independent-drill-required',
        })
        await ga.enqueue(admin.id, policy.policyId, 'drill', point.pointId, b.nodeId)
        const budget = new NodeResourceBudget(control, org, a.nodeId, {
          sampleMs: 500,
          staleMs: 2000,
          cpuTarget: 0.85,
          eventLoopTargetMs: 100,
          linuxMemoryReserveRatio: 0.1,
          maxQueued: 16,
          maxQueuedPerUser: 8,
          maxQueuedPerProject: 8,
          maxQueuedBytes: 65536,
          maxWaitMs: 30000,
        })
        await budget.configure()
        const owner = await GatewayModelBudget.open(budget, join(root, 'kernel-owner'))
        closeOwner = () => owner.close()
        const manager = new InstanceManager(
          new PostgresInstanceRepository(a, cfg.instancePortBase, new NodeProjectMetadata(a, old)),
          cfg,
          undefined,
          undefined,
          undefined,
          owner,
        )
        if (crossDirectory) {
          const op = await finishCrossReceiver(crossDirectory, projectA, admin.id, intent, manager, signal)
          await expect(old.write(recoveryBinding(op, 'source'), async () => true)).rejects.toThrow()
          return
        }
        const projectB = new PeerProjectRecovery(
          b,
          next,
          limits,
          cfg.instancePortBase,
          undefined,
          new PeerProjectFileGate(join(root, 'target-gateway-files')),
        )
        const rehearsal = await gb.claim()
        if (!rehearsal) throw new Error('No target rehearsal')
        const drill = await engine.drill(
          policy,
          point.pointId,
          { origin, user: a.nodeId, token: read, passwordFile },
          exporter,
          signal,
        )
        dispose = () => drill.dispose()
        await gb.finish(rehearsal, { recoveryMs: drill.recoveryMs })
        if (process.env.HGW_TEST_RECOVERY_ENTRY === '1') {
          await runNormalRecovery({
            a,
            b,
            cfg,
            old,
            next,
            fileProvider,
            manager,
            admin: admin.id,
            root,
            policy,
            point,
            write,
            read,
            passwordFile,
            origin,
            restic: restic!,
            drill,
            limits,
            session,
            rootId,
            volumeId: options[1]!.volumeId,
            witness,
          })
          return
        }
        const id = await projectA.request(admin.id, intent),
          op = await projectA.get(id)
        const targetWorkspace = join(root, 'restored-workspace'),
          targetHome = join(root, 'dsh')
        const targetDocs = {
          root: join(targetWorkspace, 'documents'),
          stateRoot: join(root, 'restored-metadata'),
          filesRoot: join(root, 'restored-objects'),
        }
        const files = await stagePeerProjectFiles(
          op,
          drill,
          { workspace: targetWorkspace, runtimeHome: targetHome, documents: async () => targetDocs },
          limits,
          signal,
        )
        expect(await readFile(join(targetDocs.root, 'report.txt'), 'utf8')).toBe('bytes to recover\n')
        await stagePeerProject(next, op, drill, files, limits, signal)
        const retiredTarget = new PeerProjectFileGate(join(root, 'historically-retired-state'))
        await retiredTarget.retire(op.publicId, randomUUID(), async () => true)
        const previousGateway = new PeerProjectRecovery(b, next, limits, cfg.instancePortBase, undefined, retiredTarget)
        await expect(previousGateway.confirmTarget(id)).rejects.toMatchObject({ code: 'peer-backup/project-files-retired' })
        expect((await projectA.get(id)).phase).toBe('prepared')
        await projectB.confirmTarget(id)
        await expect(next.read(recoveryBinding(op, 'target'), async () => true)).rejects.toThrow()
        await expect(projectA.activate(admin.id, id)).rejects.toThrow()
        await projectA.approveRetirement(admin.id, id)
        await control.query(
          "UPDATE harness.instances SET desired_state='running',observed_state='ready' WHERE runtime_id=$1",
          [op.runtimeId],
        )
        await expect(projectA.retireSource(id, admin.id, manager)).rejects.toMatchObject({
          code: 'peer-backup/source-not-stopped',
        })
        expect(
          (await control.query('SELECT observed_state FROM harness.instances WHERE runtime_id=$1', [op.runtimeId])).rows[0]
            .observed_state,
        ).toBe('ready')
        await control.query(
          "UPDATE harness.instances SET desired_state='stopped',observed_state='stopped' WHERE runtime_id=$1",
          [op.runtimeId],
        )
        await writeFile(join(workspace, 'pending-file.txt'), 'fresh user data')
        await expect(projectA.retireSource(id, admin.id, manager)).rejects.toMatchObject({
          code: 'peer-backup/source-files-changed',
        })
        await rm(join(workspace, 'pending-file.txt'))
        const competing = new PeerProjectFileGate(cfg.stateRoot)
        await competing.admit(op.publicId, async () => {
          await expect(projectA.retireSource(id, admin.id, manager)).rejects.toMatchObject({
            code: 'peer-backup/project-files-busy',
          })
        })
        const ownerGrant = (enabled: boolean) => control.query(
          'UPDATE harness.computer_use_permissions SET enabled=$4 WHERE organization_id=$1 AND user_id=$2 AND node_id=$3',
          [org, user, b.nodeId, enabled],
        )
        await ownerGrant(false)
        await expect(projectA.retireSource(id, admin.id, manager)).rejects.toMatchObject({ code: 'peer-backup/project-owner-unavailable' })
        await expect(old.read(project, async () => true)).resolves.toBe(true)
        await ownerGrant(true)
        await projectA.retireSource(id, admin.id, manager)
        await expect(competing.admit(op.publicId, async () => true)).rejects.toMatchObject({
          code: 'peer-backup/project-files-retired',
        })
        await expect(old.write(project, async () => true)).rejects.toThrow()
        await ownerGrant(false)
        await expect(projectA.activate(admin.id, id)).rejects.toMatchObject({ code: 'peer-backup/project-owner-unavailable' })
        await ownerGrant(true)
        await projectA.activate(admin.id, id)
        await ownerGrant(false)
        await expect(projectB.activateTarget(id)).rejects.toMatchObject({ code: 'peer-backup/project-owner-unavailable' })
        await ownerGrant(true)
        await projectB.activateTarget(id)
        const restored = recoveryBinding(op, 'target')
        expect(await next.read(restored, (tx) => readProjectScheduleWitness(tx, restored, limits, signal))).toBe(witness)
        expect(
          (
            await next.read(restored, (tx) =>
              tx.query('SELECT cwd FROM node_content.conversation_sessions WHERE runtime_id=$1 AND id=$2', [
                op.runtimeId,
                session,
              ]),
            )
          ).rows[0].cwd,
        ).toBe(targetWorkspace)
        await verifyReplacementDispatch(next, restored, session, message, join(targetHome, 'storages'))
        expect(await next.write(restored, async () => true)).toBe(true)
        await projectB.activateTarget(id)
        await expect(old.read(project, async () => true)).rejects.toThrow()
        expect((await projectA.status(admin.id, id)).targetActivatedAt).toBeTruthy()
      } finally {
        await cross?.close()
        await dispose?.()
        if (server.listening) await new Promise<void>((done) => server.close(() => done()))
        await closeRepo?.()
        await closeOwner?.()
        await Promise.all([source.end(), replacement.end(), control.end()])
        await rm(root, { recursive: true, force: true })
        if (crossDirectory) await writeExchange(join(crossDirectory, 'source-finished.json'), { closed: true })
      }
    },
    crossDirectory ? 1100000 : 90000,
  )
})
