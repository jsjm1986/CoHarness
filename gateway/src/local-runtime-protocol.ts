/** Private startup protocol and kernel boot identity for local runtime ownership. */
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { isAbsolute } from 'node:path'
import { z } from 'zod'
import { runGatewayChildCommand } from './child-command.ts'

/** Fixed maximum for the private bootstrap message, including credentials and environment. */
export const LOCAL_BOOTSTRAP_BYTES = 1024 * 1024

/**
 * Measure the same JSON payload on both sides of the startup pipe.
 * @param message - serializable JSON bootstrap input.
 * @returns the UTF-8 byte count excluding IPC framing.
 */
export function localBootstrapByteLength(message: unknown): number {
  return Buffer.byteLength(JSON.stringify(message), 'utf8')
}

const absolute = z.string().refine(isAbsolute, 'Expected an absolute path')
/** Validate the independent process input before loading credentials or allocating a runtime. */
export const localBootstrapSchema = z.object({
  kind: z.literal('start'), directory: absolute, identity: z.unknown(), record: z.unknown(),
  command: z.array(z.string()).min(1), cwd: absolute, dshHome: absolute,
  env: z.record(z.string(), z.string()), credential: z.string(),
  linuxScopeMode: z.enum(['literal-option', 'literal-default']).optional(),
  reportTiming: z.literal(true).optional(),
  logCapBytes: z.number().int().positive().safe(), controlTimeoutMs: z.number().int().min(1).max(2_147_483_647),
}).strict()

/**
 * Prepare the exact IPC message without charging optional diagnostics against the bootstrap limit.
 * @param input - startup facts before serialization.
 * @returns the validated message to send; rejects if the required payload alone exceeds the limit.
 */
export function localBootstrapMessage(input: z.input<typeof localBootstrapSchema>): z.output<typeof localBootstrapSchema> {
  const spec = localBootstrapSchema.parse(input)
  if (localBootstrapByteLength(spec) <= LOCAL_BOOTSTRAP_BYTES) return spec
  if (spec.reportTiming === true) {
    delete spec.reportTiming
    if (localBootstrapByteLength(spec) <= LOCAL_BOOTSTRAP_BYTES) return spec
  }
  throw new Error('Local runtime bootstrap exceeds its byte limit')
}

const offsetMs = z.number().min(0).max(2_147_483_647)
/** Validate the optional ready diagnostics independently of the acknowledgement. */
export const localSupervisorStagesSchema = z.object({
  ownerLeaseAdopted: offsetMs, bootIdStarted: offsetMs, bootIdVerified: offsetMs, controlListening: offsetMs,
  startingRecordWritten: offsetMs, runtimeSpawnStarted: offsetMs, runtimeSpawned: offsetMs,
  credentialDeliveryStarted: offsetMs, credentialDelivered: offsetMs, jobAssignmentFinished: offsetMs.optional(),
  runningRecordWriteStarted: offsetMs, runningRecordWritten: offsetMs, ready: offsetMs,
}).strict()

/** Monotonic offsets from bootstrap acceptance in the supervisor, not the Gateway clock. */
export type LocalSupervisorStages = z.infer<typeof localSupervisorStagesSchema>

/**
 * Read an operating-system boot UUID without deriving identity from a wall clock.
 * @param signal - cancellation retained through native probe closure.
 * @returns canonical UUID for this kernel boot; unsupported hosts fail before allocation.
 */
export async function localKernelBootId(signal?: AbortSignal): Promise<string> {
  signal?.throwIfAborted()
  let value: string
  if (process.platform === 'linux') value = await readFile('/proc/sys/kernel/random/boot_id', { encoding: 'utf8', signal })
  else if (process.platform === 'darwin') {
    value = (await runGatewayChildCommand('/usr/sbin/sysctl', ['-n', 'kern.bootsessionuuid'], 5000, signal, 1024)).stdout
  } else if (process.platform === 'win32') {
    // Windows exposes no boot UUID; the CIM last-boot timestamp is the stable
    // kernel-boot identity and is hashed into UUID form for one representation.
    const { stdout } = await runGatewayChildCommand('powershell.exe', [
      '-NoProfile', '-NonInteractive', '-Command',
      '& { (Get-CimInstance Win32_OperatingSystem).LastBootUpTime.ToUniversalTime().ToString("o") }',
    ], 10_000, signal, 1024)
    const digest = createHash('sha256').update(`win32-boot:${stdout.trim()}`).digest()
    digest[6] = (digest[6]! & 0x0f) | 0x50
    digest[8] = (digest[8]! & 0x3f) | 0x80
    value = `${digest.subarray(0, 4).toString('hex')}-${digest.subarray(4, 6).toString('hex')}`
      + `-${digest.subarray(6, 8).toString('hex')}-${digest.subarray(8, 10).toString('hex')}-${digest.subarray(10, 16).toString('hex')}`
  } else throw new Error(`Recoverable local runtime ownership is unsupported on ${process.platform}`)
  signal?.throwIfAborted()
  return z.string().uuid().parse(value.trim().toLowerCase())
}
