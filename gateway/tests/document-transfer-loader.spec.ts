/** Document transfer authority through real Loader runtimes, HTTP and filesystem publication. */
import { execFile } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { expect, it } from 'vitest'

async function run(unownedHttp = false) {
  const mode = process.env.DSH_EXAMPLE_MODE ?? 'src'
  if (mode !== 'src' && mode !== 'lib') throw new Error('DSH_EXAMPLE_MODE must be src or lib')
  const root = await mkdtemp(join(tmpdir(), 'document-transfer-loader-'))
  try {
    return await promisify(execFile)(process.execPath, [
      ...(mode === 'src' ? ['--import', import.meta.resolve('tsx/esm')] : []),
      fileURLToPath(new URL('./fixtures/document-transfer-loader.mjs', import.meta.url)), mode,
      ...(unownedHttp ? ['unowned-http'] : []),
    ], {
      cwd: root, timeout: 30_000, killSignal: 'SIGKILL',
      env: {
        ...process.env,
        HOME: root, USERPROFILE: root, DSH_HOME: join(root, '.dsh'), DSH_AGENTS_HOME: join(root, '.agents'),
        NODE_OPTIONS: undefined, NODE_PATH: undefined,
        TSX_TSCONFIG_PATH: mode === 'src' ? fileURLToPath(new URL('../../tsconfig.json', import.meta.url)) : undefined,
        DSH_GATEWAY_CREDENTIAL_FD: undefined, DSH_GATEWAY_CREDENTIAL_FILE: undefined,
        DSH_MANAGED_DATA_MANIFEST: undefined,
      },
    })
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

it('preserves copy authority and drains document HTTP work through the Loader', async () => {
  const result = await run()
  await expect(result.stdout).toMatchFileSnapshot(fileURLToPath(new URL('./expected/documents/transfer-authority.jsonl', import.meta.url)))
}, 45_000)

it('rejects an HTTP consumer that unloads before catalog delivery', async () => {
  await expect(run(true)).rejects.toMatchObject({
    code: 1,
    stdout: expect.stringContaining('"operation":"disabled-actor"'),
    stderr: expect.stringContaining('catalog delivery must finish before HTTP unload'),
  })
}, 45_000)
