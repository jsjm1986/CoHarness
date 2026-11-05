/** A machine administrator can install a scope-aware immutable snapshot provider outside all source and recovery content. */
import { lstat, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { z } from 'zod'
import { runGatewayChildCommand } from './child-command.ts'
import { privateFileState } from './node-private-file.ts'
import { PeerBackupError } from './peer-backup-repository.ts'
import {
  peerCaptureSchema,
  type PeerBackupBinding,
  type PeerBackupExporter,
  type PeerCapture,
} from './peer-backup-restic.ts'

const domains = {
  project: ['database', 'sessions', 'files', 'document-references', 'plugins', 'background-delivery'],
  personal: ['directory', 'drafts', 'sessions', 'files', 'document-references', 'plugins', 'background-delivery'],
  governance: ['principals', 'allocations', 'policies', 'audit', 'recovery-material'],
} as const
type ScopeKind = keyof typeof domains
const verified = z.object({ version: z.literal(1), checked: z.array(z.string().min(1).max(48)).max(32) }).strict()

/** Execute the administrator-selected provider with a fixed action and two private paths. No browser input selects an executable. */
export class PeerSnapshotOwner implements PeerBackupExporter {
  constructor(
    private readonly executable: string,
    private readonly kind: ScopeKind,
    private readonly timeoutMs: number,
    private readonly limits: { maxBytes: number; maxRows: number },
  ) {}

  private async invoke(
    action: 'capture' | 'validate',
    binding: PeerBackupBinding,
    payload: string,
    signal: AbortSignal,
    capture?: PeerCapture,
  ) {
    if (
      !isAbsolute(this.executable) ||
      (await realpath(this.executable)) !== resolve(this.executable) ||
      (await privateFileState(this.executable, await lstat(this.executable), 64 << 20, signal)) !== 'private'
    ) {
      throw new PeerBackupError(503, 'peer-backup/untrusted-snapshot-owner')
    }
    const dir = await mkdtemp(join(dirname(payload), 'owner-request-'))
    try {
      const request = join(dir, 'scope.json')
      await writeFile(
        request,
        JSON.stringify({
          version: 1,
          kind: this.kind,
          limits: this.limits,
          requiredDomains: domains[this.kind],
          organizationId: binding.organizationId,
          scopeId: binding.scopeId,
          policyId: binding.policyId,
          sourceNodeId: binding.sourceNodeId,
          targetNodeId: binding.targetNodeId,
          revision: binding.revision,
          capture,
        }),
        { flag: 'wx', mode: 0o600 },
      )
      const { stdout } = await runGatewayChildCommand(
        this.executable,
        [action, request, payload],
        this.timeoutMs,
        signal,
        128 * 1024,
      )
      return JSON.parse(stdout) as unknown
    } catch {
      signal.throwIfAborted()
      throw new PeerBackupError(503, 'peer-backup/snapshot-owner-unavailable')
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  }

  async capture(binding: PeerBackupBinding, payload: string, signal: AbortSignal) {
    return peerCaptureSchema.parse(await this.invoke('capture', binding, payload, signal))
  }

  async validate(binding: PeerBackupBinding, capture: PeerCapture, payload: string, signal: AbortSignal) {
    const { checked } = verified.parse(await this.invoke('validate', binding, payload, signal, capture))
    for (const required of domains[this.kind]) {
      if (!checked.includes(required) && !capture.gaps.some((value) => value.startsWith(required + ':'))) {
        throw new PeerBackupError(409, 'peer-backup/unverified-domain')
      }
    }
  }
}
