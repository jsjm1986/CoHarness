/** Managed upload authorization through real Loader, cryptographic principals, storage and PostgreSQL. @module */
import { execFile } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { expect, it } from 'vitest'

it.skipIf(process.env.HGW_TEST_DATABASE_URL === undefined)('keeps raw uploads under the same Session write permission as encoded uploads', async () => {
  const mode = process.env.DSH_EXAMPLE_MODE ?? 'src'
  if (mode !== 'src' && mode !== 'lib') throw new Error('Managed upload example requires src or lib')
  const root = await mkdtemp(join(tmpdir(), 'file-upload-managed-authorization-'))
  try {
    const launcherConfig = join(root, 'fixture-tsconfig.json')
    await writeFile(launcherConfig, JSON.stringify({ compilerOptions: {
      module: 'NodeNext', moduleResolution: 'NodeNext', target: 'ESNext', experimentalDecorators: false, paths: {},
    } }))
    const result = await promisify(execFile)(process.env.DSH_GATEWAY_FIXTURE_NODE ?? process.execPath, [
      '--import', import.meta.resolve('tsx/esm'),
      fileURLToPath(new URL('./fixtures/managed-authorization.mjs', import.meta.url)), mode,
      ...(process.env.DSH_FILE_UPLOAD_ARTIFACT_ROOT === undefined ? [] : [process.env.DSH_FILE_UPLOAD_ARTIFACT_ROOT]),
    ], { cwd: root, timeout: 60_000, killSignal: 'SIGKILL', env: { ...process.env,
      NODE_OPTIONS: undefined, NODE_PATH: undefined, DSH_HOME: join(root, '.dsh'), DSH_AGENTS_HOME: join(root, '.agents'), TMPDIR: root,
      TSX_TSCONFIG_PATH: mode === 'src' ? resolve(import.meta.dirname, '../../../../tsconfig.json') : launcherConfig,
    } })
    await expect(result.stdout).toMatchFileSnapshot(resolve(import.meta.dirname, 'expected/managed-authorization.jsonl'))
  } finally { await rm(root, { recursive: true, force: true }) }
}, 70_000)
