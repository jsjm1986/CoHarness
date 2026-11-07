/** Owned source or built SDK composition for auxiliary-model acceptance. */
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { DeepSeekHarness, type DeepSeekHarnessOptions } from '@deepseek-ai/dsh-sdk-client'
import { materializeProfilePatch } from '@deepseek-ai/dsh-session-snapshot'
import { resolveExampleMode } from '@deepseek-ai/dsh-loader-smoke'

/**
 * Own the temporary profile and runtime, including failed fixture preparation.
 * @param fixture - owned directory URL containing runtime.cordis.yml.
 * @param route - deterministic adapter route installed by the fixture.
 * @param run - assertions; additional runtimes it creates remain caller-owned.
 * @returns completion after runtime shutdown and workspace removal.
 */
export async function withAuxiliaryModelHarness(
  fixture: URL,
  route: { provider: string; model: string },
  run: (harness: DeepSeekHarness, options: DeepSeekHarnessOptions & { cwd: string }) => Promise<void>,
): Promise<void> {
  const cwd = await mkdtemp(join(tmpdir(), 'dsh-sdk-auxiliary-'))
  let harness: DeepSeekHarness | undefined
  try {
    const source = resolveExampleMode() === 'src'
    const patchRoot = join(cwd, '.snapshot-patches')
    await mkdir(patchRoot)
    const composition = new URL('runtime.cordis.yml', fixture)
    const patch = materializeProfilePatch(fileURLToPath(composition),
      cwd, 'sdk-minimal', patchRoot, 0)
    const options: DeepSeekHarnessOptions & { cwd: string } = {
      dshBin: fileURLToPath(new URL(`../../../apps/cli/${source ? 'src/bin.ts' : 'lib/bin.js'}`, import.meta.url)),
      profile: 'sdk-minimal', dshHome: join(cwd, '.dsh'), processCwd: cwd, cwd, ...route,
      initializeTimeoutMs: 110_000, requestTimeoutMs: 110_000,
      patches: [...source ? [fileURLToPath(new URL('../../../apps/cli/src/sdk-source.cordis.patch.yml', import.meta.url))] : [], patch],
      env: { ...process.env, DSH_TELEMETRY_DISABLED: '1', DSH_AGENTS_HOME: join(cwd, '.agents'),
        ...source ? {
          NODE_OPTIONS: [process.env.NODE_OPTIONS, `--import=${import.meta.resolve('tsx/esm')}`].filter(Boolean).join(' '),
          TSX_TSCONFIG_PATH: fileURLToPath(new URL('../../../apps/cli/tsconfig.json', import.meta.url)),
        } : {},
      },
    }
    harness = new DeepSeekHarness(options)
    await run(harness, options)
  } finally {
    try { await harness?.close() }
    finally { if (!process.env.DSH_AUX_KEEP_CWD) await rm(cwd, { recursive: true, force: true }) }
  }
}
