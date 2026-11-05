/** Real Loader LSP replacement waits for retryable native process cleanup. @module */
import { execFile } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { expect, it } from 'vitest'

it('retries failed language-server cleanup before allocating its replacement', async () => {
  const mode = process.env.DSH_EXAMPLE_MODE ?? 'src'
  if (mode !== 'src' && mode !== 'lib') throw new Error('LSP cleanup example requires src or lib')
  const root = await mkdtemp(join(tmpdir(), 'lsp-cleanup-retry-'))
  try {
    const result = await promisify(execFile)(process.execPath, [
      ...(mode === 'src' ? ['--import', import.meta.resolve('tsx/esm')] : []),
      fileURLToPath(new URL('./fixtures/cleanup-retry.mjs', import.meta.url)), mode,
    ], { cwd: root, timeout: 30_000, killSignal: 'SIGKILL', env: { ...process.env,
      NODE_OPTIONS: undefined, NODE_PATH: undefined, DSH_HOME: join(root, '.dsh'), DSH_AGENTS_HOME: join(root, '.agents'), TMPDIR: root,
      TSX_TSCONFIG_PATH: mode === 'src' ? resolve(import.meta.dirname, '../../../../tsconfig.json') : undefined,
    } }).catch((error: Error & { stdout?: string; stderr?: string }) => {
      error.message += `\nstdout:\n${error.stdout}\nstderr:\n${error.stderr}`
      throw error
    })
    await expect(result.stdout).toMatchFileSnapshot(resolve(import.meta.dirname, 'expected/cleanup-retry.jsonl'))
  } finally { await rm(root, { recursive: true, force: true }) }
}, 40_000)
