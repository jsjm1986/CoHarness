/** A disposable two-OS fixture. It accepts only a newly generated synthetic scope and never opens a Harness database or Runtime. */
import { createHash, randomUUID } from 'node:crypto'
import { createServer } from 'node:http'
import { cp, lstat, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { pathToFileURL } from 'node:url'
import { basename, dirname, join, posix, resolve } from 'node:path'
import { z } from 'zod'
import { PEER_REPOSITORY_PREFIX, PeerBackupError, PeerBackupRepository } from '../../src/peer-backup-repository.ts'
import { PeerBackupRestic, type PeerBackupExporter } from '../../src/peer-backup-restic.ts'
import { validatePeerProject } from '../../src/peer-backup-project-export.ts'
import { verifiedPeerFileRoots } from '../../src/peer-snapshot-roots.ts'
import { stagePeerProjectFiles } from '../../src/peer-backup-takeover-files.ts'
import type { RuntimeId } from '../../src/runtime-catalog.ts'
import { validatePeerControl } from '../../src/peer-backup-control-validation.ts'
import { exportOfflinePeerRepository } from '../../src/peer-backup-offline.ts'

const bindingSchema = z
  .object({
    organizationId: z.uuid(),
    policyId: z.uuid(),
    scopeId: z.uuid(),
    sourceNodeId: z.uuid(),
    targetNodeId: z.uuid(),
    revision: z.literal(1),
  })
  .strict()
const settings = z
  .object({
    version: z.literal(1),
    synthetic: z.literal('hgw-peer-pair-fixture'),
    binding: bindingSchema,
    file: z.string().regex(/^fixture-[a-z0-9-]+\.bin$/u),
    seed: z
      .string()
      .regex(/^[a-f0-9]{64}$/u)
      .optional(),
    appendFingerprint: z.string().regex(/^[a-f0-9]{64}$/u),
    recoveryFingerprint: z.string().regex(/^[a-f0-9]{64}$/u),
    replacement: z
      .object({ privateVolume: z.string(), nameVersion: z.uuid(), publicId: z.number().int().positive() })
      .strict()
      .optional(),
    kind: z.enum(['fixture', 'governance', 'published-project']).optional(),
    forbidden: z.array(z.string()).max(16).optional(),
    restic: z.string().optional(),
    origin: z.url().optional(),
    pointId: z.uuid().optional(),
  })
  .strict()
const hash = (v: Buffer | string) => createHash('sha256').update(v).digest('hex')
async function main() {
  const [action, configFile] = process.argv.slice(2)
  if (!configFile || !action || !['receive', 'send', 'verify'].includes(action)) throw new Error('unknown fixture action')
  const dir = await realpath(dirname(resolve(configFile)))
  if (!basename(dir).startsWith('hgw-peer-test-')) throw new Error('requires a unique synthetic subdirectory')
  const config = settings.parse(JSON.parse(await readFile(configFile, 'utf8')))
  const binding = config.binding
  const repo = join(dir, 'ciphertext'),
    staging = join(dir, 'staging')
  const lifetime = AbortSignal.timeout(180000)
  if (action === 'receive') {
    const admission = async () => {
      try {
        await lstat(join(dir, 'revoked'))
        throw new PeerBackupError(403, 'peer-backup/pair-denied')
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      }
    }
    const store = await PeerBackupRepository.open({
      directory: repo,
      nodeId: binding.targetNodeId,
      capacityBytes: 64 << 20,
      maxObjectBytes: 16 << 20,
      objectLimit: 2000,
      concurrency: 8,
      reserveBytes: 16 << 20,
      grant: async (id, user, token) => {
        await admission()
        const fingerprint = hash(token)
        if (
          id !== binding.policyId ||
          user !== binding.sourceNodeId ||
          (fingerprint !== config.appendFingerprint && fingerprint !== config.recoveryFingerprint)
        )
          throw new PeerBackupError(403, 'peer-backup/pair-denied')
        return {
          ...binding,
          mode: fingerprint === config.appendFingerprint ? 'append' : 'recover',
          quotaBytes: 48 << 20,
          revalidate: admission,
        }
      },
    })
    const server = createServer((req, res) => {
      void store.handle(req, res).then((handled) => {
        if (!handled) res.writeHead(404).end()
      })
    })
    await new Promise<void>((done) => server.listen(0, '127.0.0.1', done))
    const addr = server.address()
    if (!addr || typeof addr === 'string') throw new Error('fixture listener unavailable')
    process.stdout.write(JSON.stringify({ port: addr.port, os: process.platform }) + '\n')
    const timer = setTimeout(() => process.stdin.emit('end'), 600000)
    process.stdin.resume()
    await new Promise<void>((done) => {
      process.stdin.once('end', done)
      process.stdin.once('data', () => done())
    })
    clearTimeout(timer)
    server.closeAllConnections()
    await new Promise<void>((done) => server.close(() => done()))
    await store.close()
    const container = await readFile(join(repo, 'objects.sqlite'))
    if (
      container.includes('synthetic-only:') ||
      container.includes(config.file) ||
      container.includes('published workspace version')
    )
      throw new Error('receiver contains plaintext fixture contents')
    process.stdin.pause()
    return
  }
  if (!config.restic) throw new Error('fixture restic missing')
  const engine = new PeerBackupRestic({
    executable: config.restic,
    stagingDirectory: staging,
    uploadKiBps: 8192,
    downloadKiBps: 8192,
    timeoutMs: 120000,
    maxRestoreBytes: 16 << 20,
    reserveBytes: 16 << 20,
  })
  if (!config.seed) throw new Error('missing synthetic test witness')
  const source = join(dir, 'synthetic-source')
  const payload = Buffer.from('synthetic-only:' + config.seed + ':' + binding.scopeId)
  const validation: PeerBackupExporter['validate'] = async (_scope, capture, output, signal) => {
    if (config.kind === 'published-project') {
      await validatePeerProject(_scope, capture, output, signal, { maxRows: 12000, maxBytes: 16 << 20 })
      if (capture.gaps.length) throw new Error('published point claims incomplete coverage')
      const roots = await verifiedPeerFileRoots(_scope, output, true)
      if (!roots || roots.provider !== 'btrfs') throw new Error('missing native publication evidence')
      const manifest = JSON.parse(await readFile(join(output, 'managed', 'manifest.json'), 'utf8'))
      const workspace = roots.roots.find((r) => r.role === 'workspace')!,
        storage = roots.roots.find((r) => r.role === 'runtime-data')!
      const check = async (root: string, name: string, expected: string) => {
        const member = manifest.snapshot.files.find(
          (row: { sourcePath: string }) => row.sourcePath === posix.join(root, name),
        )
        if (!member || (await readFile(join(output, 'managed', member.member), 'utf8')) !== expected)
          throw new Error('native freeze lost original file')
      }
      await check(workspace.snapshotRoot, 'ongoing-work.txt', 'published workspace version')
      await check(storage.snapshotRoot, 'scheduled.json', '{"next":"2099-06-01T00:00:00Z"}\n')
      return
    }
    if (config.kind === 'governance') {
      await validatePeerControl(_scope, capture, output, signal, { maxRows: 2000, maxBytes: 16 << 20 })
      const raw = await readFile(join(output, 'governance.jsonl'), 'utf8')
      if (
        !raw.includes('Synthetic governance proof') ||
        !raw.includes('"table":"model_user_access"') ||
        [
          'password_hash',
          'credential_hash',
          'append_hash',
          'recovery_hash',
          'name-index.key',
          'gateway-master.key',
          ...(config.forbidden ?? []),
        ].some((item) => raw.includes(item))
      ) {
        throw new Error('fixture governance selection or key isolation failed')
      }
      return
    }
    const manifest = JSON.parse(await readFile(join(output, 'session.json'), 'utf8')) as {
      scope: string
      events: string[]
      file: string
      sha256: string
      delivery: string
      generation: number
    }
    if (
      manifest.scope !== binding.scopeId ||
      manifest.events.join('|') !== 'created|completed' ||
      manifest.file !== config.file ||
      manifest.sha256 !== hash(payload) ||
      manifest.generation !== Number(capture.watermark) ||
      manifest.delivery !== 'synthetic-completed-once' ||
      hash(await readFile(join(output, config.file))) !== manifest.sha256
    )
      throw new Error('fixture semantic validation failed')
  }
  if (action === 'send') {
    if (!config.origin) throw new Error('fixture repository origin missing')
    await mkdir(source, { mode: 0o700 })
    await writeFile(join(source, config.file), payload, { flag: 'wx', mode: 0o600 })
    const token = (await readFile(join(dir, 'append.token'), 'utf8')).trim()
    const access = { origin: config.origin, user: binding.sourceNodeId, token, passwordFile: join(dir, 'source.key') }
    let generation = 0
    const exporter: PeerBackupExporter = {
      capture: async (_scope, output) => {
        generation++
        if (config.kind === 'published-project') {
          const frozen = join(dir, 'published-project')
          if ((await realpath(frozen)) !== frozen) throw new Error('unowned fixture directory')
          const publication = JSON.parse(await readFile(join(frozen, 'publication.json'), 'utf8'))
          if (bindingSchema.parse(publication.policy).scopeId !== _scope.scopeId)
            throw new Error('point belongs to another test')
          for (const directory of ['managed', 'project'])
            await cp(join(frozen, 'payload', directory), join(output, directory), {
              recursive: true,
              force: false,
              errorOnExist: true,
            })
          return publication.point
        }
        await writeFile(join(output, config.file), await readFile(join(source, config.file)), { flag: 'wx', mode: 0o600 })
        await writeFile(
          join(output, 'session.json'),
          JSON.stringify({
            scope: binding.scopeId,
            events: ['created', 'completed'],
            file: config.file,
            sha256: hash(payload),
            delivery: 'synthetic-completed-once',
            generation,
          }),
          { flag: 'wx', mode: 0o600 },
        )
        return {
          version: 1,
          organizationId: binding.organizationId,
          sourceNodeId: binding.sourceNodeId,
          scopeId: binding.scopeId,
          writerEpoch: '1',
          watermark: String(generation),
          capturedAt: new Date().toISOString(),
          coveredCount: 3,
          gaps: [],
        }
      },
      validate: validation,
    }
    const started = Date.now()
    const first = await engine.backup(binding, access, exporter, randomUUID(), lifetime)
    const second = await engine.backup(binding, access, exporter, randomUUID(), lifetime)
    const again = await engine.backup(binding, access, exporter, second.pointId, lifetime)
    const captureMs = Date.now() - started
    const check = async (policy: string, suffix: string, method: string, user?: string, bearer?: string) => {
      const url = new URL(PEER_REPOSITORY_PREFIX + policy + '/' + suffix, access.origin)
      const response = await fetch(url, { method, redirect: 'error', signal: lifetime,
        headers: user && bearer ? { authorization: 'Basic ' + Buffer.from(user + ':' + bearer).toString('base64') } : {} })
      await response.body?.cancel()
      return response.status
    }
    const denials = {
      anonymous: await check(binding.policyId, 'usage', 'GET'),
      wrongSource: await check(binding.policyId, 'usage', 'GET', randomUUID(), token),
      wrongPolicy: await check(randomUUID(), 'usage', 'GET', binding.sourceNodeId, token),
      wrongCredential: await check(binding.policyId, 'usage', 'GET', binding.sourceNodeId, randomUUID()),
      appendCannotDeleteSnapshot: await check(binding.policyId, 'snapshots/' + second.snapshotId, 'DELETE', binding.sourceNodeId, token),
    }
    if (denials.anonymous !== 401 || Object.entries(denials).some(([key, status]) => key !== 'anonymous' && status !== 403)) {
      throw new Error('receiver accepted an unauthorized identity or destructive capability')
    }
    if (again.snapshotId !== second.snapshotId || first.snapshotId === second.snapshotId || generation !== 2)
      throw new Error('fixture point sequence failed')
    await rm(source, { recursive: true })
    if (config.kind === 'published-project') await rm(join(dir, 'published-project'), { recursive: true })
    await rm(access.passwordFile)
    process.stdout.write(
      JSON.stringify({
        os: process.platform,
        points: 2,
        pointId: second.pointId,
        bytes: second.repositoryBytes,
        receivedAt: second.capturedAt,
        captureMs,
        denials,
        idempotent: true,
        syntheticSourceRemoved: true,
      }) + '\n',
    )
    return
  }
  if (!config.pointId) throw new Error('fixture point required')
  const checkout = await exportOfflinePeerRepository({
    ...binding,
    repositoryDirectory: repo,
    privateRecoveryDirectory: join(dir, 'isolated'),
    pointId: config.pointId,
    maxBytes: 32 << 20,
    reserveBytes: 16 << 20,
    signal: lifetime,
  })
  try {
    const wrong = join(dir, 'wrong.key')
    await writeFile(wrong, randomUUID() + randomUUID(), { flag: 'wx', mode: 0o600 })
    let wrongRejected = false
    try {
      const invalid = await engine.drillOffline(
        checkout.point,
        checkout.repository,
        wrong,
        { validate: validation },
        lifetime,
      )
      await invalid.dispose()
    } catch (error) {
      if (error instanceof PeerBackupError && error.code === 'peer-backup/restic-incomplete') wrongRejected = true
      else throw error
    } finally {
      await rm(wrong)
    }
    if (!wrongRejected) throw new Error('an incorrect recovery password was accepted')
    const restored = await engine.drillOffline(
      checkout.point,
      checkout.repository,
      join(dir, 'recovery.key'),
      { validate: validation },
      lifetime,
    )
    try {
      let nativeFiles
      if (config.kind === 'published-project') {
        const roles = await verifiedPeerFileRoots(binding, restored.directory, true)
        if (!roles) throw new Error('missing restored root map')
        const out = join(dir, 'verified-replacement')
        await mkdir(out, { mode: 0o700 })
        const workspace = join(out, 'workspace'),
          home = join(out, 'dsh')
        const op = {
          id: randomUUID(),
          organizationId: binding.organizationId,
          projectId: binding.scopeId,
          runtimeId: roles.runtimeId as RuntimeId,
          sourceNode: binding.sourceNodeId,
          sourceVolume: roles.volumeId,
          oldEpoch: roles.writerEpoch,
          targetNode: binding.targetNodeId,
          targetVolume: randomUUID(),
          newEpoch: String(BigInt(roles.writerEpoch) + 1n),
          pointId: restored.point.pointId,
          revision: roles.revision,
          digest: restored.point.manifestDigest,
          phase: 'prepared',
          publicId: config.replacement?.publicId ?? 1,
          scheduleDigest: null,
          filesDigest: null,
          targetPortBase: null,
          policyId: binding.policyId,
          policyRevision: 1,
          origin: 'admin' as const,
          nameId: config.replacement?.nameVersion ?? randomUUID(),
          retirementActor: null,
        }
        const result = await stagePeerProjectFiles(
          op,
          restored,
          {
            workspace,
            runtimeHome: home,
            documents: async () => ({
              root: join(workspace, 'documents'),
              filesRoot: join(out, 'private-objects'),
              stateRoot: join(out, 'private-metadata'),
            }),
          },
          { maxBytes: 16 << 20, maxRows: 12000, reserveBytes: 16 << 20 },
          lifetime,
        )
        if (
          result.documentRootId !== roles.documentRootId ||
          (await readFile(join(workspace, 'ongoing-work.txt'), 'utf8')) !== 'published workspace version' ||
          (await readFile(join(home, 'storages', 'scheduled.json'), 'utf8')) !== '{"next":"2099-06-01T00:00:00Z"}\n'
        )
          throw new Error('replacement bytes differ')
        const physical = config.replacement
          ? await (
              await import(pathToFileURL(join(dir, 'gateway', 'lib', 'physical.js')).href)
            ).stageWindowsDatabase(op, restored, result, config.replacement.privateVolume, lifetime)
          : {}
        nativeFiles = {
          ...physical,
          publishedSQLiteAndProject: true,
          workspaceFrozen: true,
          documentIdentityRebound: true,
          sourceFileRoleCount: roles.roots.length,
          targetWriterPublished: false,
        }
      }
      process.stdout.write(
        JSON.stringify({
          os: process.platform,
          pointId: restored.point.pointId,
          watermark: restored.point.watermark,
          RTOms: restored.recoveryMs,
          ...(nativeFiles ??
            (config.kind === 'governance'
              ? { organizationRowsVerified: true, keysExcluded: true }
              : { hasFileBytes: true, sessionEvents: 2, deliveryReceipts: 1 })),
          remainingGaps: restored.point.gapCount,
          wrongKeyRejected: wrongRejected,
        }) + '\n',
      )
    } finally {
      await restored.dispose()
    }
  } finally {
    await checkout.dispose()
  }
}
main().catch((error) => {
  process.stderr.write(
    (error instanceof PeerBackupError ? error.code : error instanceof Error ? error.message : 'fixture-failed') + '\n',
  )
  process.exitCode = 1
})
