/** Gateway-owned work retains kernel ownership; HTTP inference also shares node admission. */
import { randomUUID } from 'node:crypto'
import { createHash } from 'node:crypto'
import { constants, type BigIntStats } from 'node:fs'
import { lstat, mkdir, open, unlink, type FileHandle } from 'node:fs/promises'
import { createServer } from 'node:net'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { tryLockExclusive } from '@deepseek-ai/node-addon-system/flock'
import type { ResourceOperationId } from '@deepseek-ai/dsh-resource-budget/types'
import { NodeResourceBudget, type GatewayResourceOwner, type GatewayResourceOwnerId, type GatewayResourceLock,
  type NodeResourceRequest } from './node-resource-budget.ts'

/** Human-triggered work retains its initiating user; sweeps share the infrastructure user (zero). */
export interface GatewayModelRequest {
  readonly actorId: number
  readonly projectId: number
  readonly signal: AbortSignal
}

/** Callbacks execute in this process; this owner cannot prove independently surviving subprocesses stopped. */
export class GatewayModelBudget {
  private readonly stop = new AbortController()
  private readonly pending = new Set<Promise<unknown>>()
  private readonly unfinished = new Map<NodeResourceRequest, 'not-started' | 'quiescent'>()
  private registration: Promise<void> = Promise.resolve()
  private sequence = 0
  private closed = false
  private retired = false
  private lockClosed = false
  private disposed = false
  private closing: Promise<void> | undefined

  private constructor(private readonly budget: NodeResourceBudget, private readonly owner: GatewayResourceOwner,
    private readonly directory: string, private readonly handle: FileHandle, private readonly witness: GatewayResourceLock,
    private readonly kernel: KernelLease) {}

  /**
   * Recover only matching, unlocked inodes before registering this process's unique kernel lock.
   * @param budget - node-wide durable scheduler.
   * @param directory - private, stable node-local lock directory shared by Gateway processes.
   * @returns owner whose close operation must precede database pool disposal.
   */
  static async open(budget: NodeResourceBudget, directory: string): Promise<GatewayModelBudget> {
    await mkdir(directory, { recursive: true, mode: 0o700 })
    for (const owner of await budget.gateways()) {
      let handle: FileHandle
      try { handle = await open(join(directory, `${owner.ownerId}.lock`), constants.O_RDWR | constants.O_NOFOLLOW) } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue
        throw error
      }
      try {
        if (!await sameInode(handle, directory, owner.ownerId, owner)) continue
        let kernel: KernelLease
        try { kernel = await kernelLease(handle.fd, join(directory, `${owner.ownerId}.lock`)) } catch (error) {
          const code = (error as NodeJS.ErrnoException).code
          if (code === 'EAGAIN' || code === 'EWOULDBLOCK' || code === 'EADDRINUSE') continue
          throw error
        }
        if (!await sameInode(handle, directory, owner.ownerId, owner)) { await kernel.release(); continue }
        await budget.gatewayStopped(owner)
        await unlink(join(directory, `${owner.ownerId}.lock`))
        await kernel.release()
      } finally { await handle.close() }
    }
    const ownerId = randomUUID() as GatewayResourceOwnerId
    const lockPath = join(directory, `${ownerId}.lock`)
    const handle = await open(lockPath, 'wx+', 0o600)
    try {
      const kernel = await kernelLease(handle.fd, lockPath)
      const stat = await handle.stat({ bigint: true })
      const witness = { device: String(stat.dev), inode: String(stat.ino) }
      if (!await sameInode(handle, directory, ownerId, witness)) { await kernel.release(); throw new Error('Gateway resource lock was replaced') }
      return new GatewayModelBudget(budget, await budget.registerGateway(ownerId, witness), directory, handle, witness, kernel)
    } catch (error) {
      // Registration may have committed before a failed acknowledgement. Keep its inode for recovery.
      await handle.close()
      throw error
    }
  }

  /**
   * Wait fairly, then own a complete model callback and its accounting acknowledgement.
   * @param request - verified project and initiating actor, with caller cancellation.
   * @param execute - complete HTTP request/body consumer; must honor cancellation and join its work before settling.
   * @returns the callback result after quiescent accounting commits.
   */
  run<T>(request: GatewayModelRequest, execute: (signal: AbortSignal, operationId: ResourceOperationId) => Promise<T>): Promise<T> {
    if (this.closed) return Promise.reject(new Error('Gateway model admission is closed'))
    const task = this.execute(request, execute)
    this.pending.add(task)
    void task.then(() => this.pending.delete(task), () => this.pending.delete(task))
    return task
  }

  /**
   * Retain this process's kernel witness through administrative work without reserving a model credit.
   * @param execute - complete local operation; all writes and cleanup must settle before it returns.
   * @returns its result; close joins the callback before retiring the durable process owner.
   */
  withOwnership<T>(execute: (owner: GatewayResourceOwner) => Promise<T>): Promise<T> {
    if (this.closed) return Promise.reject(new Error('Gateway process ownership is closed'))
    const task = Promise.resolve().then(() => execute(this.owner))
    this.pending.add(task)
    void task.then(() => this.pending.delete(task), () => this.pending.delete(task))
    return task
  }

  /** Cancel and join all callbacks; failed cleanup retains the kernel lock for a retry or process-death recovery. */
  close(): Promise<void> {
    if (this.disposed) return Promise.resolve()
    if (this.closing !== undefined) return this.closing
    const task = this.closeOwned()
    this.closing = task
    void task.then(() => { this.closing = undefined }, () => { this.closing = undefined })
    return task
  }

  private async closeOwned(): Promise<void> {
    this.closed = true
    this.stop.abort(new Error('Gateway model admission is shutting down'))
    await Promise.allSettled([...this.pending])
    for (const [operation, outcome] of this.unfinished) await this.finish(operation, outcome)
    if (!this.retired) {
      await this.budget.gatewayStopped(this.owner)
      this.retired = true
    }
    if (!this.lockClosed) {
      await this.handle.close()
      await this.kernel.release()
      this.lockClosed = true
    }
    const path = join(this.directory, `${this.owner.ownerId}.lock`)
    try {
      const stat = await lstat(path, { bigint: true })
      if (stat.isFile() && String(stat.dev) === this.witness.device && String(stat.ino) === this.witness.inode) await unlink(path)
    } catch (error) {
      // Another recovery may have removed the same retired owner's file; replacement inodes stay untouched.
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
    this.disposed = true
  }

  private async execute<T>(request: GatewayModelRequest, execute: (signal: AbortSignal, operationId: ResourceOperationId) => Promise<T>): Promise<T> {
    const signal = AbortSignal.any([request.signal, this.stop.signal])
    let operation: NodeResourceRequest | undefined
    let started = false
    try {
      signal.throwIfAborted()
      const registered = this.registration.then(async () => {
        signal.throwIfAborted()
        operation = { requestId: randomUUID() as ResourceOperationId, sequence: ++this.sequence, kind: 'model',
          actorId: request.actorId, projectId: request.projectId, origin: 'runtime' }
        try { return await this.budget.request(this.owner, operation) } catch (error) {
          // Fence the serial counter even when a registration acknowledgement was lost.
          await this.finish(operation, 'not-started')
          throw error
        }
      })
      this.registration = registered.then(() => undefined, () => undefined)
      let status = await registered
      while (status.state === 'queued') {
        await delay(this.budget.config.sampleMs, undefined, { signal })
        status = await this.budget.status(this.owner, operation!)
      }
      signal.throwIfAborted()
      if (status.state !== 'active') throw new Error(`Gateway model admission ${status.state}`)
      started = true
      return await execute(signal, operation!.requestId)
    } finally {
      if (operation !== undefined) await this.finish(operation, started ? 'quiescent' : 'not-started')
    }
  }

  private async finish(operation: NodeResourceRequest, outcome: 'not-started' | 'quiescent'): Promise<void> {
    this.unfinished.set(operation, outcome)
    try {
      await this.budget.finish(this.owner, operation, outcome)
      this.unfinished.delete(operation)
    } catch (error) {
      this.closed = true
      this.stop.abort(new Error('Gateway model accounting could not confirm cleanup'))
      throw error
    }
  }
}

/** Kernel-held exclusion over a Gateway resource lock: POSIX flock on the descriptor, Windows a machine-unique pipe name derived from the lock path (process death releases either). */
interface KernelLease { readonly release: () => Promise<void> }

/** Pipe names must be unique per lock path without leaking host layout into the shared namespace. */
function kernelPipeName(lockPath: string): string {
  return `\\\\.\\pipe\\dsh-gw-owner-${createHash('sha256').update(lockPath).digest('hex')}`
}

/**
 * Acquire kernel exclusion over the lock file or throw on contention (EAGAIN/EWOULDBLOCK on POSIX, EADDRINUSE on win32).
 * @param fd - descriptor whose flock carries the lease on POSIX; unused on win32.
 * @param lockPath - durable lock path hashed into the win32 pipe name.
 * @returns a release for the win32 pipe server; the POSIX release is descriptor-close owned by the caller.
 */
async function kernelLease(fd: number, lockPath: string): Promise<KernelLease> {
  if (process.platform !== 'win32') { await tryLockExclusive(fd); return { release: () => Promise.resolve() } }
  const server = createServer()
  try {
    await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(kernelPipeName(lockPath), resolve) })
  } catch (error) {
    await new Promise(resolve => server.close(resolve))
    throw error
  }
  return { release: () => new Promise(resolve => server.close(() => resolve())) }
}

async function sameInode(handle: FileHandle, directory: string, ownerId: GatewayResourceOwnerId, witness: GatewayResourceLock): Promise<boolean> {
  const descriptor = await handle.stat({ bigint: true })
  let path: BigIntStats
  try { path = await lstat(join(directory, `${ownerId}.lock`), { bigint: true }) } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw error
  }
  return path.isFile() && String(descriptor.dev) === witness.device && String(descriptor.ino) === witness.inode
    && String(path.dev) === witness.device && String(path.ino) === witness.inode
}
