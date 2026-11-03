/** Private startup protocol and kernel boot identity for local runtime ownership. */
import { readFile } from 'node:fs/promises'
import { isAbsolute } from 'node:path'
import { z } from 'zod'
import { runGatewayChildCommand } from './child-command.ts'

/** Fixed maximum for the private bootstrap message, including credentials and environment. */
export const LOCAL_BOOTSTRAP_BYTES = 1024 * 1024
const absolute = z.string().refine(isAbsolute, 'Expected an absolute path')
/** Validate the independent process input before loading credentials or allocating a runtime. */
export const localBootstrapSchema = z.object({
  kind: z.literal('start'), directory: absolute, identity: z.unknown(), record: z.unknown(),
  command: z.array(z.string()).min(1), cwd: absolute, dshHome: absolute,
  env: z.record(z.string(), z.string()), credential: z.string(),
  linuxScopeMode: z.enum(['literal-option', 'literal-default']).optional(),
  logCapBytes: z.number().int().positive().safe(), controlTimeoutMs: z.number().int().min(1).max(2_147_483_647),
}).strict()

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
  } else throw new Error(`Recoverable local runtime ownership is unsupported on ${process.platform}`)
  signal?.throwIfAborted()
  return z.string().uuid().parse(value.trim().toLowerCase())
}
