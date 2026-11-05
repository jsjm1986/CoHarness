/** Launch the ordinary Gateway with equal managed roots and require refusal before database startup. */
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdtemp, rm, access } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

const execute = promisify(execFile), mode = process.argv[2], artifact = process.argv[3]
assert.ok(mode === 'src' || mode === 'lib')
const gateway = fileURLToPath(new URL('../../', import.meta.url))
const entry = mode === 'src' ? join(gateway, 'src/index.ts') : join(resolve(artifact || join(gateway, 'lib')), 'index.js')
for (const kind of ['steward', 'project', 'user-project']) {
  const root = await mkdtemp(join(tmpdir(), 'hgw-strict-workspace-'))
  try {
    const data = join(root, 'data'), steward = join(root, 'steward')
    const env = {
      PATH: process.env.PATH, HOME: root, USERPROFILE: root,
      HGW_DATABASE_URL: 'postgresql://fixture@127.0.0.1:1/strict_configuration_test',
      HGW_DEFAULT_ENV_FILE: '', HGW_STATE_ROOT: join(root, 'state'),
      HGW_USERS_ROOT: join(root, 'users'), HGW_PROJECT_RUNTIMES_ROOT: join(root, 'runtimes'),
      HGW_PROJECTS_ROOT: join(data, 'projects'), HGW_USER_PROJECTS_ROOT: join(data, 'user-projects'),
      TSX_TSCONFIG_PATH: join(gateway, 'tsconfig.run.json'),
      ...kind === 'steward' ? { HGW_STEWARD: 'on', HGW_STEWARD_ROOT: steward, HGW_STEWARD_WORKSPACE: join(steward, 'child', '..') }
        : { HGW_LAUNCHER: 'systemd', HGW_PROJECT_PATH_ROOTS: data,
          [kind === 'project' ? 'HGW_PROJECTS_ROOT' : 'HGW_USER_PROJECTS_ROOT']: join(data, 'child', '..') },
    }
    let failure
    try { await execute(process.execPath, [...mode === 'src' ? ['--import', import.meta.resolve('tsx/esm')] : [], entry],
      { env, timeout: 15000, maxBuffer: 128 * 1024 }) } catch (error) { failure = error }
    assert.equal(failure?.code, 1)
    assert.equal(failure.killed, false)
    assert.match(failure.stderr, /must be a strict descendant/u)
    assert.doesNotMatch(failure.stderr, /ECONNREFUSED|database-startup|password authentication/u)
    await assert.rejects(access(join(root, 'runtimes')), { code: 'ENOENT' })
    console.log(JSON.stringify({ kind, refusedAtConfiguration: true, runtimeFilesAbsent: true }))
  } finally { await rm(root, { recursive: true, force: true }) }
}
