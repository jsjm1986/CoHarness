/** Real Loader authorization cancellation and credential storage on provider withdrawal. @module */
import { execFile } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { expect, it } from 'vitest'

it('keeps retired authorization flows from interacting or writing a new credential', async () => {
  const mode = process.env.DSH_EXAMPLE_MODE ?? 'src'
  if (mode !== 'src' && mode !== 'lib') throw new Error('Authorization owner example requires src or lib')
  const root = await mkdtemp(join(tmpdir(), 'authorization-owner-'))
  try {
    const result = await promisify(execFile)(process.execPath, [
      ...(mode === 'src' ? ['--import', import.meta.resolve('tsx/esm')] : []),
      fileURLToPath(new URL('./fixtures/owner-lifetime.mjs', import.meta.url)), mode,
      ...(process.env.DSH_AUTHORIZATION_ARTIFACT_ROOT === undefined ? [] : [process.env.DSH_AUTHORIZATION_ARTIFACT_ROOT]),
    ], { cwd: root, timeout: 30_000, killSignal: 'SIGKILL', env: { ...process.env,
      NODE_OPTIONS: undefined, NODE_PATH: undefined, DSH_HOME: join(root, '.dsh'), DSH_AGENTS_HOME: join(root, '.agents'), TMPDIR: root,
      TSX_TSCONFIG_PATH: mode === 'src' ? resolve(import.meta.dirname, '../../../../tsconfig.json') : undefined,
    } })
    await expect(result.stdout).toMatchFileSnapshot(resolve(import.meta.dirname, 'expected/owner-lifetime.jsonl'))
  } finally { await rm(root, { recursive: true, force: true }) }
}, 40_000)
