/** Exact-generation local recovery without signalling a numeric PID from disk. */
import { request } from 'node:http'
import { performance } from 'node:perf_hooks'
import type { InstanceProc } from './launcher.ts'
import { runGatewayChildCommand } from './child-command.ts'
import { LocalRuntimeOwnerStore, type LocalRuntimeOwnerLease, type LocalRuntimeOwnerRecord } from './local-runtime-owner.ts'
import { localKernelBootId } from './local-runtime-protocol.ts'
import { localLinuxRuntimeEmpty, stopLocalLinuxRuntime } from './local-runtime-linux.ts'
import { isDeadlineKilledCommand } from './child-command.ts'

const POLL_MS = 25

/** Authenticated controller; unconfirmed cleanup remains a failed operation for capacity accounting. */
export class LocalRuntimeControl implements InstanceProc {
  private confirmedStopped = false
  private stopping: Promise<void> | undefined
  private bootIdentity: string | undefined

  constructor(readonly store: LocalRuntimeOwnerStore, private readonly timeoutMs: number) {}

  hasExited(): boolean { return this.confirmedStopped }

  async isAlive(): Promise<boolean> {
    if (this.confirmedStopped) return false
    const bootId = await this.kernelBoot()
    const record = await this.requiredRecord(bootId)
    if (record.phase === 'stopped' || record.bootId !== bootId) {
      if (await this.confirmStopped(bootId)) return false
      throw new Error('Local runtime stop evidence is still occupied')
    }
    try {
      const status = await this.call(record, 'status', 0, this.timeoutMs)
      return status.runtimeAlive && status.phase === 'running'
    } catch (error) {
      if (await this.confirmStopped(bootId)) return false
      throw error
    }
  }

  terminate(graceMs: number): Promise<void> {
    return this.stopping ??= this.stop(graceMs).catch(error => { this.stopping = undefined; throw error })
  }

  private async kernelBoot(): Promise<string> {
    return this.bootIdentity ??= await localKernelBootId()
  }

  private async requiredRecord(bootId?: string): Promise<LocalRuntimeOwnerRecord> {
    const record = await this.store.read(bootId)
    if (record === undefined) throw new Error('Local runtime owner evidence is missing; termination is unconfirmed')
    return record
  }

  private async stop(graceMs: number): Promise<void> {
    if (!Number.isSafeInteger(graceMs) || graceMs < 0 || graceMs > 86_400_000) throw new Error('Invalid local runtime termination grace')
    await this.store.cancel()
    const bootId = await this.kernelBoot()
    const deadline = performance.now() + graceMs + this.timeoutMs
    const forceAfter = performance.now() + graceMs
    let requested = false
    for (;;) {
      const record = await this.requiredRecord(bootId)
      if (await this.confirmStopped(bootId)) return
      const remaining = deadline - performance.now()
      if (remaining <= 0) throw new Error('Local runtime termination could not be confirmed; capacity remains occupied')
      if (!requested && record.bootId === bootId && record.url !== undefined) {
        try { await this.call(record, 'stop', graceMs, Math.max(1, Math.min(remaining, this.timeoutMs))); requested = true } catch {
          // A lost response is not termination evidence; retry only the same authenticated generation.
        }
      }
      if (record.nativeRange === 'linux-slice' && record.bootId === bootId && performance.now() >= forceAfter) {
        try {
          await stopLocalLinuxRuntime(record, Math.max(1, Math.floor(Math.min(deadline - performance.now(), this.timeoutMs))))
        } catch (error) {
          // A deadline-killed native command is one more unconfirmed round; the
          // loop deadline alone reports the retained capacity.
          if (!isDeadlineKilledCommand(error)) throw error
        }
      }
      if (process.platform === 'win32' && record.bootId === bootId && record.groupPid !== undefined
        && performance.now() >= forceAfter) {
        await runGatewayChildCommand('taskkill.exe', ['/PID', String(record.groupPid), '/T', '/F'], this.timeoutMs).catch(() => {})
      }
      await new Promise(resolve => setTimeout(resolve, Math.min(POLL_MS, Math.max(1, deadline - performance.now()))))
    }
  }

  private async confirmStopped(bootId: string): Promise<boolean> {
    let lease: LocalRuntimeOwnerLease
    try { lease = await this.store.acquireExisting(bootId) } catch (error) {
      if (['EAGAIN', 'EWOULDBLOCK', 'EADDRINUSE'].includes((error as NodeJS.ErrnoException).code ?? '')) {
        // The lease may be held by an orphan that inherited the supervisor's
        // descriptor: reap the record's dead-leader group so the next poll
        // acquires the lease instead of reporting 'occupied' forever.
        if (process.platform !== 'win32') await this.reapOrphanedGroup(bootId)
        return false
      }
      throw error
    }
    try {
      const current = await this.requiredRecord(bootId)
      if (current.bootId !== bootId) {
        await this.store.cancel()
        await lease.confirmPreviousBootStop(bootId)
        this.confirmedStopped = true
        return true
      }
      if (current.groupPid !== undefined && this.groupExists(current.groupPid)) {
        // POSIX only: a dead supervisor leaves orphaned group members (e.g. a
        // SIGKILLed supervisor's dsh child still holding the instance port).
        // A live process group cannot host foreign members and its pgid is the
        // record-bound spawn allocation, so leader death proves the survivors
        // belong to this generation — reap them instead of reporting
        // 'occupied' forever. Windows sweeps orphans by parent link below.
        if (process.platform !== 'win32' && this.leaderDead(current.groupPid)) {
          try { process.kill(-current.groupPid, 'SIGKILL') } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error
          }
          await new Promise(resolve => setTimeout(resolve, POLL_MS))
        }
        if (this.groupExists(current.groupPid)) return false
      }
      if (process.platform === 'win32' && current.groupPid !== undefined) {
        // A dead supervisor leaves no process-group handle; sweep its orphaned
        // descendants by parent link before the generation may fence.
        await this.sweepOrphans(current.groupPid)
      }
      if (current.nativeRange === 'linux-slice') {
        try {
          if (!await localLinuxRuntimeEmpty(current, this.timeoutMs)) return false
          await stopLocalLinuxRuntime(current, this.timeoutMs)
        } catch (error) {
          // A deadline-killed slice query could not confirm absence.
          if (!isDeadlineKilledCommand(error)) throw error
          return false
        }
      }
      await this.store.cancel()
      if (current.phase !== 'stopped') {
        const stopping = current.phase === 'reserved' || current.phase === 'stopping' ? current
          : await lease.publish({ ...current, phase: 'stopping' })
        await lease.publish({ ...stopping, phase: 'stopped' })
      }
      this.confirmedStopped = true
      return true
    } finally { await lease.close() }
  }

  /** Kill every descendant tree rooted at a dead supervisor's children. */
  private async sweepOrphans(parentPid: number): Promise<void> {
    const { stdout } = await runGatewayChildCommand('powershell.exe', [
      '-NoProfile', '-NonInteractive', '-Command',
      `& { (Get-CimInstance Win32_Process -Filter "ParentProcessId=${String(parentPid)}").ProcessId -join "," }`,
    ], this.timeoutMs, undefined, 4096)
    for (const pid of stdout.trim().split(',').map(Number).filter(pid => Number.isSafeInteger(pid) && pid > 0)) {
      await runGatewayChildCommand('taskkill.exe', ['/PID', String(pid), '/T', '/F'], this.timeoutMs).catch(() => {})
    }
  }

  private groupExists(pid: number): boolean {
    // Windows has no process-group probe: groupPid is the supervisor itself.
    const target = process.platform === 'win32' ? pid : -pid
    try { process.kill(target, 0); return true } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (code === 'ESRCH') return false
      if (code === 'EPERM') return true
      throw error
    }
  }

  /**
   * POSIX orphan reap: when the record-bound `groupPid` group is alive but its
   * leader (the supervisor itself) is dead, surviving members — including one
   * holding the inherited lease descriptor — are this generation's own
   * orphans. A live process group cannot host foreign members and the pgid is
   * the record's spawn allocation, so the group is SIGKILLed and re-probed
   * instead of reporting 'occupied' forever.
   * @param bootId - kernel boot identity fencing earlier-boot records.
   * @returns whether a reap ran; the caller re-polls for the freed lease.
   */
  private async reapOrphanedGroup(bootId: string): Promise<boolean> {
    const record = await this.store.read(bootId)
    if (record?.groupPid === undefined || !this.leaderDead(record.groupPid)
      || !this.groupExists(record.groupPid)) return false
    try { process.kill(-record.groupPid, 'SIGKILL') } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error
    }
    return true
  }

  /** Whether the process-group leader itself is gone while members may remain. */
  private leaderDead(pid: number): boolean {
    try { process.kill(pid, 0); return false } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (code === 'ESRCH') return true
      if (code === 'EPERM') return false
      throw error
    }
  }

  private call(record: LocalRuntimeOwnerRecord, operation: 'status' | 'stop', graceMs: number, timeoutMs: number): Promise<{ phase: string; runtimeAlive: boolean }> {
    if (record.url === undefined) return Promise.reject(new Error('Local runtime owner has not published its control endpoint'))
    return new Promise((resolve, reject) => {
      const body = JSON.stringify({ nonce: record.nonce, operation, graceMs })
      const outgoing = request(record.url!, { method: 'POST', headers: {
        authorization: `Bearer ${record.token}`, 'content-type': 'application/json', 'content-length': Buffer.byteLength(body), connection: 'close',
      } }, response => {
        const chunks: Buffer[] = []; let bytes = 0
        response.on('data', (chunk: Buffer) => {
          bytes += chunk.length
          if (bytes > 4096) { outgoing.destroy(new Error('Local runtime control response exceeds its byte limit')); return }
          chunks.push(chunk)
        })
        response.once('error', reject)
        response.once('close', () => { if (!response.complete) reject(new Error('Local runtime control response closed before completion')) })
        response.once('end', () => {
          try {
            const result = JSON.parse(Buffer.concat(chunks).toString('utf8')) as { nonce?: unknown; phase?: unknown; runtimeAlive?: unknown }
            if (response.statusCode !== 200 || result.nonce !== record.nonce || typeof result.phase !== 'string'
              || typeof result.runtimeAlive !== 'boolean') throw new Error('Local runtime control did not confirm its owner')
            resolve({ phase: result.phase, runtimeAlive: result.runtimeAlive })
          } catch (error) { reject(error) }
        })
      })
      const timer = setTimeout(() => outgoing.destroy(new Error('Local runtime control timed out')), timeoutMs)
      outgoing.once('error', reject); outgoing.once('close', () => clearTimeout(timer)); outgoing.end(body)
    })
  }
}
