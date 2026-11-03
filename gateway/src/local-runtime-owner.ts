/** Durable local-runtime identities and inherited kernel allocation leases. */
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { closeSync, constants, fstatSync } from 'node:fs'
import { lstat, mkdir, open, rename, rm, type FileHandle } from 'node:fs/promises'
import { createServer } from 'node:net'
import { isAbsolute, join } from 'node:path'
import { tryLockExclusive } from '@deepseek-ai/node-addon-system/flock'
import type { Branded } from '@deepseek-ai/dsh-brand'
import { z } from 'zod'
import { privateDirectoryState, privateFileState, syncStateDirectory, tightenPrivateFileAcl } from './node-private-file.ts'

const OWNER_RECORD_BYTES = 65_536
const identitySchema = z.object({
  node: z.string().min(1),
  kind: z.enum(['user', 'project']),
  ownerId: z.number().int().positive().safe(),
  runtimeKey: z.string().min(1),
  generation: z.number().int().nonnegative().safe(),
  credentialHash: z.string().regex(/^[a-f0-9]{64}$/u),
}).strict()
const witnessSchema = z.object({ device: z.string().regex(/^\d+$/u), inode: z.string().regex(/^\d+$/u) }).strict()
const phaseSchema = z.enum(['reserved', 'starting', 'running', 'stopping', 'uncertain', 'stopped'])
/** Opaque capability identity for one independently owned runtime allocation. */
export type LocalRuntimeOwnerNonce = Branded<'LocalRuntimeOwnerNonce'>
const recordSchema = z.object({
  version: z.literal(1), identity: identitySchema, lock: witnessSchema,
  nonce: z.string().uuid().transform(value => value as LocalRuntimeOwnerNonce), token: z.string().regex(/^[\w-]{43}$/u),
  bootId: z.string().uuid(), phase: phaseSchema,
  nativeRange: z.literal('linux-slice').optional(),
  url: z.string().optional(), groupPid: z.number().int().positive().safe().optional(),
}).strict().superRefine((record, ctx) => {
  if (record.url === undefined !== (record.groupPid === undefined)
    || ['starting', 'running', 'stopping', 'uncertain'].includes(record.phase) && record.url === undefined) {
    ctx.addIssue({ code: 'custom', message: 'Allocated local runtime ownership requires its endpoint and process group' })
  }
  if (record.url === undefined) return
  let url: URL
  try { url = new URL(record.url) } catch {
    ctx.addIssue({ code: 'custom', message: 'Invalid local runtime control URL' }); return
  }
  if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || url.port === '' || url.pathname !== '/'
    || url.username !== '' || url.password !== '' || url.search !== '' || url.hash !== '') {
    ctx.addIssue({ code: 'custom', message: 'Local runtime control requires a private loopback endpoint' })
  }
})

/** One node's exact durable runtime generation and credential fingerprint. */
export type LocalRuntimeIdentity = z.infer<typeof identitySchema>
/** Private recovery capability; it never enters runtime environment or command arguments. */
export type LocalRuntimeOwnerRecord = z.infer<typeof recordSchema>

const transitions: Readonly<Record<LocalRuntimeOwnerRecord['phase'], readonly LocalRuntimeOwnerRecord['phase'][]>> = {
  reserved: ['starting', 'stopped'],
  starting: ['running', 'stopping', 'uncertain', 'stopped'],
  running: ['stopping', 'uncertain'],
  stopping: ['uncertain', 'stopped'],
  uncertain: ['stopping', 'stopped'],
  stopped: [],
}

/** Private generation files remain stable across Gateway restarts and application-data restores. */
export class LocalRuntimeOwnerStore {
  readonly identity: LocalRuntimeIdentity
  readonly recordPath: string
  readonly lockPath: string
  readonly cancellationPath: string

  constructor(readonly directory: string, identity: unknown) {
    if (!isAbsolute(directory)) throw new Error('Local runtime ownership requires an absolute private directory')
    this.identity = identitySchema.parse(identity)
    const key = createHash('sha256').update(JSON.stringify(this.identity)).digest('hex')
    this.recordPath = join(directory, `${key}.json`)
    this.lockPath = join(directory, `${key}.lock`)
    this.cancellationPath = join(directory, `${key}.cancel`)
  }

  /**
   * Read a bounded, private record bound to this generation's unchanged lock inode.
   * @param kernelBootId - current kernel boot UUID, allowing a remounted device only for earlier-boot recovery.
   * @returns the current owner, or absence before a reservation has committed.
   */
  async read(kernelBootId?: string): Promise<LocalRuntimeOwnerRecord | undefined> {
    try { await this.verifyDirectory() } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
      throw error
    }
    let handle: FileHandle
    try { handle = await open(this.recordPath, constants.O_RDONLY | constants.O_NOFOLLOW) } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
      throw error
    }
    try {
      const stat = await handle.stat()
      if (await privateFileState(this.recordPath, stat, OWNER_RECORD_BYTES) !== 'private') {
        throw new Error('Local runtime owner record is not a bounded private file')
      }
      const bytes = Buffer.alloc(OWNER_RECORD_BYTES + 1)
      let length = 0
      while (length < bytes.length) {
        const { bytesRead } = await handle.read(bytes, length, bytes.length - length, length)
        if (bytesRead === 0) break
        length += bytesRead
      }
      if (length > OWNER_RECORD_BYTES) throw new Error('Local runtime owner record exceeds its byte limit')
      const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, length))
      const record = recordSchema.parse(JSON.parse(text))
      if (JSON.stringify(record.identity) !== JSON.stringify(this.identity)) throw new Error('Local runtime generation identity changed')
      const lock = await lstat(this.lockPath, { bigint: true })
      if (!lock.isFile() || String(lock.ino) !== record.lock.inode
        || String(lock.dev) !== record.lock.device && (kernelBootId === undefined || kernelBootId === record.bootId)) {
        throw new Error('Local runtime ownership lock was replaced')
      }
      return record
    } finally { await handle.close() }
  }

  /**
   * Obtain the nonblocking kernel lease before any independently surviving allocation.
   * The returned descriptor can be inherited by the supervisor and runtime.
   * @returns exclusive lease; contention retains the existing owner.
   */
  async acquire(): Promise<LocalRuntimeOwnerLease> {
    await this.prepareDirectory()
    return await this.openLease(true)
  }

  /**
   * Recover only an existing allocation inode; absence cannot prove a legacy runtime stopped.
   * @param kernelBootId - current kernel boot UUID for earlier-boot device renumbering.
   * @returns exclusive ownership of the current descriptor and path.
   */
  async acquireExisting(kernelBootId?: string): Promise<LocalRuntimeOwnerLease> {
    await this.verifyDirectory()
    return await this.openLease(false, kernelBootId)
  }

  private async openLease(create: boolean, kernelBootId?: string): Promise<LocalRuntimeOwnerLease> {
    if (process.platform === 'win32') return await this.openPipeLease(create, kernelBootId)
    const handle = await open(this.lockPath, constants.O_RDWR | (create ? constants.O_CREAT : 0) | constants.O_NOFOLLOW, 0o600)
    try {
      await tryLockExclusive(handle.fd)
      const stat = await handle.stat({ bigint: true })
      const witness = { device: String(stat.dev), inode: String(stat.ino) }
      const lease = new LocalRuntimeOwnerLease(this, {
        fd: handle.fd,
        stat: async () => { const stat = await handle.stat({ bigint: true }); return { device: String(stat.dev), inode: String(stat.ino) } },
        close: () => handle.close(),
      }, witness)
      await lease.verify()
      await this.read(kernelBootId)
      return lease
    } catch (error) {
      try { await handle.close() } catch (cleanupError) {
        throw new AggregateError([error, cleanupError], 'Local runtime lease acquisition and cleanup failed')
      }
      throw error
    }
  }

  /**
   * Windows kernel lease: an exclusively named pipe replaces the POSIX lock
   * descriptor. Pipe names are machine-unique, `listen` refuses duplicates and
   * the kernel releases the name on owner death, matching flock semantics;
   * the `.lock` file remains the durable inode witness. No descriptor is
   * inheritable on Windows, so the supervisor acquires this lease itself
   * instead of adopting a descriptor.
   */
  private async openPipeLease(create: boolean, kernelBootId?: string): Promise<LocalRuntimeOwnerLease> {
    if (create) {
      const handle = await open(this.lockPath, constants.O_RDWR | constants.O_CREAT, 0o600)
      try { await handle.sync() } finally { await handle.close() }
      await syncStateDirectory(this.directory)
    }
    const stat = await lstat(this.lockPath, { bigint: true })
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('Local runtime ownership lock is not a private file')
    const witness = { device: String(stat.dev), inode: String(stat.ino) }
    const server = createServer()
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(this.pipeName, () => { server.off('error', reject); resolve() })
    })
    try {
      const lease = new LocalRuntimeOwnerLease(this, {
        fd: -1,
        stat: async () => {
          const current = await lstat(this.lockPath, { bigint: true })
          return { device: String(current.dev), inode: String(current.ino) }
        },
        close: () => new Promise<void>(resolve => server.close(() => resolve())),
      }, witness)
      await lease.verify()
      await this.read(kernelBootId)
      return lease
    } catch (error) {
      await new Promise<void>(resolve => server.close(() => resolve()))
      throw error
    }
  }

  /** Machine-unique pipe name bound to this exact private lock path. */
  get pipeName(): string {
    return `\\\\.\\pipe\\dsh-owner-${createHash('sha256').update(this.lockPath).digest('hex').slice(0, 32)}`
  }

  /** Record stop intent even while another process holds the allocation lease. */
  async cancel(): Promise<void> {
    await this.prepareDirectory()
    if (process.platform === 'win32') {
      const existing = await lstat(this.cancellationPath).catch(() => undefined)
      if (existing?.isSymbolicLink()) throw new Error('Local runtime cancellation path is a reparse point')
    }
    const handle = await open(this.cancellationPath, constants.O_WRONLY | constants.O_CREAT | constants.O_NOFOLLOW, 0o600)
    try { await handle.sync() } finally { await handle.close() }
    await syncStateDirectory(this.directory)
  }

  /** @returns whether stop intent fences this generation's pending allocation. */
  async cancelled(): Promise<boolean> {
    try { await lstat(this.cancellationPath); return true } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
      throw error
    }
  }

  private async prepareDirectory(): Promise<void> {
    await mkdir(this.directory, { recursive: true, mode: 0o700 })
    await this.verifyDirectory()
  }

  private async verifyDirectory(): Promise<void> {
    const stat = await lstat(this.directory)
    if (await privateDirectoryState(this.directory, stat) !== 'private') {
      throw new Error('Local runtime ownership requires a private directory')
    }
  }
}

interface OwnerDescriptor {
  readonly fd: number
  stat(): Promise<LocalRuntimeOwnerRecord['lock']>
  close(): Promise<void>
}

/** One open file description; inherited descriptors retain the same kernel lease. */
export class LocalRuntimeOwnerLease {
  private mutations: Promise<void> = Promise.resolve()
  private disposal: Promise<void> | undefined

  constructor(readonly store: LocalRuntimeOwnerStore, private readonly handle: OwnerDescriptor,
    readonly witness: LocalRuntimeOwnerRecord['lock']) {}

  /**
   * Validate the inherited reservation before the independent owner may allocate.
   * @param store - generation-specific private journal.
   * @param fd - descriptor inherited from the Gateway's open file description.
   * @param expected - reservation delivered over the private startup channel.
   * @returns the same kernel lease, owned by this process until close or exit.
   */
  static async inherit(store: LocalRuntimeOwnerStore, fd: number, expected: unknown): Promise<LocalRuntimeOwnerLease> {
    const record = recordSchema.parse(expected)
    const lease = new LocalRuntimeOwnerLease(store, {
      fd,
      stat: () => { const stat = fstatSync(fd, { bigint: true }); return Promise.resolve({ device: String(stat.dev), inode: String(stat.ino) }) },
      close: () => { closeSync(fd); return Promise.resolve() },
    }, record.lock)
    await lease.verify()
    await tryLockExclusive(fd)
    const current = await store.read()
    if (current?.nonce !== record.nonce || current.token !== record.token || current.phase !== 'reserved'
      || await store.cancelled()) throw new Error('Local runtime inherited reservation is fenced')
    return lease
  }

  /**
   * Windows-only self-acquisition for the supervisor, which cannot inherit a
   * descriptor: it claims the named-pipe lease itself, retrying while the
   * launching Gateway still holds it, then applies the same reservation
   * fences as {@link inherit}.
   * @param store - generation-specific private journal.
   * @param expected - reservation delivered over the private startup channel.
   * @param timeoutMs - bounded wait for the launcher's lease release.
   * @returns the same kernel lease, owned by this process until close or exit.
   */
  static async adopt(store: LocalRuntimeOwnerStore, expected: unknown, timeoutMs: number): Promise<LocalRuntimeOwnerLease> {
    const record = recordSchema.parse(expected)
    const deadline = performance.now() + timeoutMs
    for (;;) {
      try {
        const lease = await store.acquireExisting()
        try {
          const current = await store.read()
          if (current?.nonce !== record.nonce || current.token !== record.token || current.phase !== 'reserved'
            || await store.cancelled()) throw new Error('Local runtime inherited reservation is fenced')
          return lease
        } catch (error) {
          await lease.close().catch(() => {})
          throw error
        }
      } catch (error) {
        const occupied = (error as NodeJS.ErrnoException).code === 'EADDRINUSE'
        if (!occupied || performance.now() >= deadline) throw error
        await new Promise(resolve => setTimeout(resolve, 50))
      }
    }
  }

  /** Descriptor stays caller-owned until inherited allocation has acknowledged its handoff. */
  get fd(): number { return this.handle.fd }

  /** Refuse lock-path replacement instead of adopting another inode's apparent vacancy. */
  async verify(): Promise<void> {
    const [descriptor, path] = await Promise.all([this.handle.stat(), lstat(this.store.lockPath, { bigint: true })])
    if (!path.isFile() || String(path.dev) !== this.witness.device || String(path.ino) !== this.witness.inode
      || descriptor.device !== this.witness.device || descriptor.inode !== this.witness.inode) {
      throw new Error('Local runtime ownership lock was replaced')
    }
  }

  /**
   * Commit the allocation reservation before starting its independent owner.
   * @param bootId - kernel boot identity, independent of the wall clock.
   * @param nativeRange - positively probed native descendant containment, when available.
   * @returns newly persisted capability; an existing generation is never reopened.
   */
  create(bootId: string, nativeRange?: 'linux-slice'): Promise<LocalRuntimeOwnerRecord> {
    return this.mutate(async () => {
      if (await this.store.read() !== undefined || await this.store.cancelled()) throw new Error('Local runtime generation is already fenced')
      const record = recordSchema.parse({ version: 1, identity: this.store.identity, lock: this.witness,
        nonce: randomUUID(), token: randomBytes(32).toString('base64url'), bootId, phase: 'reserved',
        ...nativeRange === undefined ? {} : { nativeRange } })
      await this.write(record)
      return record
    })
  }

  /**
   * Commit one legal lifecycle transition while retaining the original capability and inode.
   * Only the current allocation owner writes after descriptor handoff.
   * @param record - next record for this exact owner.
   * @returns the committed record.
   */
  publish(record: LocalRuntimeOwnerRecord): Promise<LocalRuntimeOwnerRecord> {
    return this.mutate(async () => {
      const next = recordSchema.parse(record), current = await this.store.read()
      if (current === undefined || current.nonce !== next.nonce || current.token !== next.token
        || current.nativeRange !== next.nativeRange
        || current.bootId !== next.bootId || JSON.stringify(next.identity) !== JSON.stringify(this.store.identity)
        || next.lock.device !== this.witness.device || next.lock.inode !== this.witness.inode
        || current.url !== undefined && next.url !== current.url
        || current.groupPid !== undefined && next.groupPid !== current.groupPid) throw new Error('Local runtime owner capability changed')
      if (!transitions[current.phase].includes(next.phase)) throw new Error('Local runtime owner transition is fenced')
      await this.write(next)
      return next
    })
  }

  /**
   * Retire an earlier boot after acquiring and verifying the current kernel lease.
   * @param kernelBootId - positively observed current boot, which must differ from the saved boot.
   * @returns terminal record retaining its generation and capability with the current device witness.
   */
  confirmPreviousBootStop(kernelBootId: string): Promise<LocalRuntimeOwnerRecord> {
    return this.mutate(async () => {
      const record = await this.store.read(kernelBootId)
      if (record === undefined || record.bootId === kernelBootId) throw new Error('Local runtime requires a confirmed different kernel boot')
      const stopped = { ...record, phase: 'stopped' as const, lock: this.witness }
      await this.write(stopped)
      return stopped
    })
  }

  /** Join admitted mutations before closing this descriptor; inherited descriptors remain owned. */
  close(): Promise<void> {
    return this.disposal ??= (async () => { await this.mutations; await this.handle.close() })()
  }

  private mutate<T>(work: () => Promise<T>): Promise<T> {
    if (this.disposal !== undefined) return Promise.reject(new Error('Local runtime ownership lease is closed'))
    const pending = this.mutations.then(async () => { await this.verify(); return await work() })
    this.mutations = pending.then(() => {}, () => {})
    return pending
  }

  private async write(record: LocalRuntimeOwnerRecord): Promise<void> {
    const text = JSON.stringify(record) + '\n'
    if (Buffer.byteLength(text) > OWNER_RECORD_BYTES) throw new Error('Local runtime owner record exceeds its byte limit')
    const path = join(this.store.directory, `.${randomUUID()}.tmp`)
    const handle = await open(path, 'wx', 0o600)
    try {
      try { await handle.writeFile(text); await handle.sync() } finally { await handle.close() }
      await this.verify()
      await rename(path, this.store.recordPath)
      await tightenPrivateFileAcl(this.store.recordPath)
      const directory = await open(this.store.directory, 'r').catch((error: unknown) => {
        if (process.platform === 'win32' && (error as NodeJS.ErrnoException).code === 'EISDIR') return undefined
        throw error
      })
      try { await directory?.sync() } finally { await directory?.close() }
    } finally { await rm(path, { force: true }) }
  }
}
