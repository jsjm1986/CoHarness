/** Coordinate one disposable Linux source with the Windows receiver over externally owned loopback SSH forwards. */
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { createConnection, createServer } from 'node:net'
import { lstat, readFile, realpath, rename, writeFile } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import type { AddressInfo } from 'node:net'
import type { PeerBackupPolicy } from '../src/peer-backup-governance.ts'
import type { PeerProjectRecovery } from '../src/peer-backup-takeover.ts'
import type { InstanceManager } from '../src/instances.ts'

/** User-controlled prompts and filenames are never written to the test coordinator. */
export interface ReceiverOffer {
  policy: PeerBackupPolicy
  targetVolume: string
  organizationSlug: string
  rootId: string
  session: string
  previousDelivery: string
  runtimeId: string
  recoveryToken: string
  password: string
}
export async function writeExchange<T>(path: string, value: T) {
  const temporary = path + '.' + randomUUID()
  await writeFile(temporary, JSON.stringify(value), { mode: 0o600, flag: 'wx' })
  await rename(temporary, path)
}
export async function waitExchange<T>(path: string, signal: AbortSignal): Promise<T> {
  for (;;) {
    signal.throwIfAborted()
    try {
      await lstat(join(dirname(path), 'abort.json'))
      throw new Error('The synthetic peer qualification was cancelled.')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
    try {
      return JSON.parse(await readFile(path, 'utf8'))
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
    await sleep(300, undefined, { signal })
  }
}

export async function prepareCrossReceiver(
  directory: string,
  governanceUrl: string,
  offer: ReceiverOffer,
  signal: AbortSignal,
) {
  const id = basename(directory)
  const info = await lstat(directory)
  if (
    (process.platform !== 'linux' && process.platform !== 'darwin') ||
    !/^[a-f0-9-]{36}$/u.test(id) ||
    (await realpath(directory)) !== directory ||
    (info.mode & 0o077) !== 0 ||
    (await readFile(join(directory, 'fixture-owner'), 'utf8')) !== id
  )
    throw new Error('Unowned cross-machine qualification exchange.')
  const url = new URL(governanceUrl),
    socket = url.searchParams.get('host')
  if (
    !socket ||
    !/^\/tmp\/hgw-pg-socket-[a-zA-Z0-9]+$/u.test(socket) ||
    url.pathname !== '/hgw_governance_test' ||
    url.username !== 'postgres' ||
    !url.password
  ) {
    throw new Error('Only the dedicated synthetic PostgreSQL Unix socket is eligible.')
  }
  const sockets = new Set<ReturnType<typeof createConnection>>()
  const tunnel = createServer((connection) => {
    const backend = createConnection(join(socket, '.s.PGSQL.5432'))
    for (const one of [connection, backend]) {
      sockets.add(one)
      one.once('close', () => sockets.delete(one))
    }
    backend.on('error', () => connection.destroy())
    connection.on('error', () => backend.destroy())
    backend.pipe(connection).pipe(backend)
  })
  await new Promise<void>((ok, reject) => {
    tunnel.once('error', reject)
    tunnel.listen(0, '127.0.0.1', ok)
  })
  const close = async () => {
    for (const socket of sockets) socket.destroy()
    await new Promise<void>((done) => tunnel.close(() => done()))
  }
  try {
    await writeExchange(join(directory, 'offer.json'), {
      ...offer,
      pgPort: (tunnel.address() as AddressInfo).port,
      fixture: id,
      dbPassword: decodeURIComponent(url.password),
    })
    const mapped = await waitExchange<{ port: number }>(join(directory, 'receiver.json'), signal)
    assert.ok(Number.isSafeInteger(mapped.port) && mapped.port > 1024 && mapped.port <= 65535)
    return { origin: 'http://127.0.0.1:' + mapped.port, close }
  } catch (error) {
    await close()
    throw error
  }
}

/** Leave the full decision to the owning source and replacement services, including failed busy retirement. */
export async function finishCrossReceiver(
  directory: string,
  service: PeerProjectRecovery,
  admin: number,
  intent: { requestId: string; pointId: string; policyId: string; targetNode: string; targetVolume: string },
  manager: InstanceManager,
  signal: AbortSignal,
) {
  await writeExchange(join(directory, 'captured.json'), { pointId: intent.pointId })
  await waitExchange(join(directory, 'rehearsed.json'), signal)
  const id = await service.request(admin, intent)
  await writeExchange(join(directory, 'operation.json'), { id })
  await waitExchange(join(directory, 'candidate.json'), signal)
  const prepared = await service.status(admin, id)
  assert.equal(prepared.phase, 'target-ready')
  await assert.rejects(service.activate(admin, id))
  await service.approveRetirement(admin, id)
  const { context } = service
  const operation = await service.get(id)
  await context.pool.query(
    "UPDATE harness.instances SET desired_state='running',observed_state='ready' WHERE runtime_id=$1",
    [operation.runtimeId],
  )
  await assert.rejects(service.retireSource(id, admin, manager, signal), { code: 'peer-backup/source-not-stopped' })
  const state = (
    await context.pool.query('SELECT observed_state FROM harness.instances WHERE runtime_id=$1', [operation.runtimeId])
  ).rows[0]
  assert.equal(state.observed_state, 'ready')
  await context.pool.query(
    "UPDATE harness.instances SET desired_state='stopped',observed_state='stopped' WHERE runtime_id=$1",
    [operation.runtimeId],
  )
  await service.retireSource(id, admin, manager, signal)
  await service.activate(admin, id)
  await writeExchange(join(directory, 'switched.json'), { id })
  await waitExchange(join(directory, 'delivered.json'), signal)
  assert.ok((await service.status(admin, id)).targetActivatedAt)
  return operation
}
