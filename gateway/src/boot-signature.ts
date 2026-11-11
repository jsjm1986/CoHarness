/**
 * Launch-signature persistence deciding whether Runtimes surviving a previous
 * Gateway process may be reused: an unchanged signature means the same code
 * owns them, a changed or missing signature means their code may be stale and
 * they must be retired before serving requests.
 * @module gateway/boot-signature
 */
import { createHash } from 'node:crypto'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { extname, join } from 'node:path'
import { z } from 'zod'
import { runGatewayChildCommand } from './child-command.ts'
import type { GatewayConfig } from './config.ts'

const SIGNATURE_FILE = 'boot-signature.json'
const SIGNATURE_GIT_TIMEOUT_MS = 3_000

const signatureSchema = z.object({
  version: z.literal(1),
  releaseRoot: z.string(),
  dshRepoRoot: z.string(),
  node: z.string(),
  nodePath: z.string(),
  launcher: z.string(),
  dshCommand: z.array(z.string()),
  supervisorSha256: z.string(),
  entrySha256: z.string(),
  gitHead: z.string(),
}).strict()

/** Identity of the code that would spawn and supervise a Runtime generation. */
export type RuntimeBootSignature = z.infer<typeof signatureSchema>

const hashFile = async (path: string | undefined): Promise<string> => {
  if (path === undefined) return ''
  try { return createHash('sha256').update(await readFile(path)).digest('base64url') }
  catch { return '' }
}

/**
 * Find the Runtime entry script inside `dshCommand`: the first argument naming
 * an on-disk script file. Arguments such as `--import <specifier>` or flags are
 * skipped; a missing file hashes to an empty string rather than failing boot.
 */
const dshEntryScript = (dshCommand: readonly string[]): string | undefined =>
  dshCommand.find(arg => /\.(?:cjs|mjs|js|ts)$/.test(extname(arg)))

/**
 * Read the signature recorded by the previous Gateway run.
 * @param stateRoot - private Gateway state directory holding the record.
 * @returns the prior signature, or undefined when absent or unreadable — both
 *   mean the launch identity cannot be confirmed unchanged.
 */
export async function readBootSignature(stateRoot: string): Promise<RuntimeBootSignature | undefined> {
  try { return signatureSchema.parse(JSON.parse(await readFile(join(stateRoot, SIGNATURE_FILE), 'utf8'))) }
  catch { return undefined }
}

/**
 * Persist this run's launch signature for the next Gateway process.
 * Written only after the drain decision consumed the prior record, so a crash
 * between drain and write leaves a stale signature that drains again —
 * conservative in both directions.
 * @param stateRoot - private Gateway state directory holding the record.
 * @param signature - this run's identity.
 */
export async function writeBootSignature(stateRoot: string, signature: RuntimeBootSignature): Promise<void> {
  const path = join(stateRoot, SIGNATURE_FILE)
  const temporary = `${path}.${String(process.pid)}.tmp`
  await mkdir(stateRoot, { recursive: true })
  await writeFile(temporary, `${JSON.stringify(signature)}\n`, { mode: 0o600 })
  await rename(temporary, path)
}

/**
 * Compute the launch signature for this process. Hashes the supervisor and
 * Runtime entry files so a same-path rebuild still reads as a changed
 * signature; `gitHead` additionally fingerprints source-tree deployments whose
 * entry files are thin launchers.
 * @param cfg - resolved Gateway configuration.
 * @returns this run's identity.
 */
export async function runtimeBootSignature(cfg: GatewayConfig): Promise<RuntimeBootSignature> {
  const source = import.meta.url.endsWith('.ts')
  const supervisorEntry = fileURLToPath(new URL(`./local-runtime-supervisor.${source ? 'ts' : 'js'}`, import.meta.url))
  const dshEntry = dshEntryScript(cfg.dshCommand)
  const gitHead = await runGatewayChildCommand('git', ['-C', cfg.dshRepoRoot, 'rev-parse', 'HEAD'], SIGNATURE_GIT_TIMEOUT_MS)
    .then(result => result.stdout.trim())
    .catch(() => '')
  const [supervisorSha256, entrySha256] = await Promise.all([hashFile(supervisorEntry), hashFile(dshEntry)])
  return {
    version: 1,
    releaseRoot: cfg.releaseRoot ?? '',
    dshRepoRoot: cfg.dshRepoRoot,
    node: process.version,
    nodePath: process.execPath,
    launcher: cfg.launcher,
    dshCommand: [...cfg.dshCommand],
    supervisorSha256,
    entrySha256,
    gitHead,
  }
}
