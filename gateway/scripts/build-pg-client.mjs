/** Build the optional maintenance adapter against the operator's PostgreSQL client installation. */
import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, rename, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs, promisify } from 'node:util'

// The production build emits gateway/lib; the standalone CI lane compiles the
// same sources into gateway/lib-ci, so the lib root is overridable.
const { scrubbedGatewayChildEnv } = await import(new URL(`${process.env.HGW_GATEWAY_LIB_DIR ?? '../lib'}/child-environment.js`, import.meta.url).href)

const { values } = parseArgs({ options: { 'pg-config': { type: 'string', default: 'pg_config' },
  cc: { type: 'string', default: process.platform === 'win32' ? 'cl.exe' : 'cc' } } })
const execute = promisify(execFile), env = scrubbedGatewayChildEnv()
const coordinate = async flag => (await execute(values['pg-config'], [flag], { env })).stdout.trim()
const include = await coordinate('--includedir'), library = await coordinate('--libdir')
if (process.platform === 'win32') {
  const pathKey = Object.keys(env).find(key => key.toUpperCase() === 'PATH') ?? 'PATH'
  env[pathKey] = `${await coordinate('--bindir')};${env[pathKey] ?? ''}`
}
const directory = fileURLToPath(new URL('../lib/native/', import.meta.url))
await mkdir(directory, { recursive: true })
const temporary = await mkdtemp(join(directory, '.pg-client-build-'))
const filename = `hgw-pg-client${process.platform === 'win32' ? '.exe' : ''}`
const output = join(temporary, filename)
const source = fileURLToPath(new URL('../deploy/postgres/pg-client.c', import.meta.url))
try {
  const arguments_ = process.platform === 'win32'
    ? ['/nologo', '/std:c11', '/W4', '/WX', '/D_CRT_SECURE_NO_WARNINGS', `/I${include}`, source,
      `/Fo${join(temporary, 'pg-client.obj')}`, `/Fe${output}`, '/link', `/LIBPATH:${library}`, 'libpq.lib']
    : ['-std=c11', '-Wall', '-Wextra', '-Werror', `-I${include}`, source, `-L${library}`, `-Wl,-rpath,${library}`, '-lpq', '-o', output]
  await execute(values.cc, arguments_, { env })
  const version = await execute(output, ['--protocol-version'], { env })
  if (version.stdout !== 'hgw-pg-client/1\n') throw new Error('PostgreSQL adapter protocol verification failed.')
  await rename(output, join(directory, filename))
  console.log(`Built PostgreSQL private connection adapter: ${filename}`)
} finally { await rm(temporary, { recursive: true, force: true }) }
