/** Run Gateway artifact acceptance without source loaders or module search overrides. */
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

for (const fixture of ['runtime-start-built.mjs', 'project-progress-built.mjs']) {
  const result = spawnSync(process.execPath, [fileURLToPath(new URL(`./fixtures/${fixture}`, import.meta.url))], {
    cwd: fileURLToPath(new URL('../', import.meta.url)),
    env: { ...process.env, NODE_OPTIONS: undefined, NODE_PATH: undefined, TSX_TSCONFIG_PATH: undefined, DSH_MANAGED_DATA_MANIFEST: undefined },
    stdio: 'inherit', timeout: 120_000, killSignal: 'SIGKILL',
  })
  if (result.error !== undefined) throw result.error
  assert.equal(result.signal, null, 'artifact acceptance must finish before its process deadline')
  assert.equal(result.status, 0, 'compiled Gateway admission acceptance failed')
}
