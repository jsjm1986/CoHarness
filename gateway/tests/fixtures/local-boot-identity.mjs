/** Keyless native boot identity and actual LocalLauncher cancellation, through source or emitted Gateway. */
import assert from 'node:assert/strict'
import childProcess from 'node:child_process'
import { syncBuiltinESMExports } from 'node:module'
import { promisify } from 'node:util'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { setTimeout as delay } from 'node:timers/promises'

const [mode, artifactRoot = '-', selected = 'all'] = process.argv.slice(2)
assert.ok(mode === 'src' || mode === 'lib')
assert.ok(artifactRoot === '-' || mode === 'lib')
assert.notEqual(process.platform, 'win32')
const base = artifactRoot === '-' ? new URL(`../../${mode}/`, import.meta.url) : pathToFileURL(`${resolve(artifactRoot)}/`)
const platform = Object.getOwnPropertyDescriptor(process, 'platform'), originalExecFile = childProcess.execFile
const execute = promisify(originalExecFile), originalDatabase = process.env.HGW_DATABASE_URL
let program
const redirected = args => args[0] === '/usr/sbin/sysctl' ? [process.execPath, [program], ...args.slice(2)] : args
childProcess.execFile = Object.assign((...args) => Reflect.apply(originalExecFile, undefined, redirected(args)), {
  [promisify.custom]: (...args) => Reflect.apply(execute, undefined, redirected(args)),
})
syncBuiltinESMExports()
Object.defineProperty(process, 'platform', { ...platform, value: 'darwin' })
const transcript = []
async function endpoint(marker, release = false) {
  try { return await (await fetch(`${marker.url}/${release ? 'release/' : ''}${marker.token}`, { headers: { connection: 'close' }, signal: AbortSignal.timeout(1000) })).text() }
  catch (error) { if (['ECONNREFUSED', 'ECONNRESET'].includes(error.cause?.code)) return undefined; throw error }
}
async function bounded(pending, timeoutMs) {
  let timer
  try { return await Promise.race([pending, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Boot identity client outlived its owner deadline')), timeoutMs) })]) }
  finally { clearTimeout(timer) }
}
async function scenario(config, action) {
  const root = await mkdtemp(join(tmpdir(), 'hgw-boot-identity-')), controller = new AbortController()
  let marker, pending, primaryError
  try {
    program = join(root, 'sysctl.mjs')
    await writeFile(program, await readFile(new URL('./local-boot-sysctl.mjs', import.meta.url), 'utf8'))
    await writeFile(join(root, 'fixture.json'), JSON.stringify(config), { mode: 0o600 })
    const start = request => { pending = request.then(value => ({ value }), error => ({ error })); return pending }
    const witness = async () => {
      const deadline = performance.now() + 20_000
      while (marker === undefined) {
        try { marker = JSON.parse(await readFile(join(root, 'ready.json'), 'utf8')) }
        catch (error) { if (error.code !== 'ENOENT' || performance.now() >= deadline) throw error; await delay(10) }
      }
      assert.equal(await endpoint(marker), marker.token)
    }
    await action({ root, controller, start, witness, closed: async () => assert.equal(await endpoint(marker), undefined) })
  } catch (error) { primaryError = error; throw error }
  finally {
    const failures = []
    controller.abort(new Error('Owned boot identity cleanup'))
    if (marker !== undefined) { try { await endpoint(marker, true) } catch (error) { failures.push(error) } }
    await pending
    try { await rm(root, { recursive: true, force: true }) } catch (error) { failures.push(error) }
    if (failures.length > 0) throw new AggregateError(primaryError === undefined ? failures : [primaryError, ...failures], 'Boot identity fixture cleanup failed')
  }
}
try {
  const [{ localKernelBootId }, { LocalLauncher }, { loadConfig }] = await Promise.all([
    'local-runtime-protocol', 'launcher', 'config',
  ].map(name => import(new URL(`${name}.${mode === 'src' ? 'ts' : 'js'}`, base))))
  const cases = {
    async credentials() {
      await scenario({ output: '12345678-1234-4234-8234-123456789ABC\n' }, async ({ root, start }) => {
        process.env.HGW_DATABASE_URL = 'postgres://synthetic.invalid/not-a-credential'
        assert.equal((await start(localKernelBootId())).value, '12345678-1234-4234-8234-123456789abc')
        const calls = (await readFile(join(root, 'calls.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line))
        assert.ok(calls.length > 0 && calls.every(row => !row.databasePresent))
        transcript.push('Kernel boot identity normalizes the UUID without exposing Gateway database settings to its native client.')
      })
    },
    async cancellation() {
      await scenario({}, async ({ root, controller, start, witness, closed }) => {
        const cfg = loadConfig({ HGW_USERS_ROOT: join(root, 'users'), HGW_STATE_ROOT: join(root, 'state'),
          HGW_PROJECTS_ROOT: join(root, 'projects'), HGW_USER_PROJECTS_ROOT: join(root, 'user-projects'),
          HGW_PROJECT_RUNTIMES_ROOT: join(root, 'runtimes'), HGW_SYSTEMD_UNIT_DIR: join(root, 'units'), HGW_DEFAULT_ENV_FILE: '' })
        let allocated = false
        const request = start(new LocalLauncher(cfg).start({ kind: 'user', ownerId: 1, username: 'fixture',
          runtimeKey: 'fixture', systemUser: 'harness-fixture', generation: 1, port: 42001,
          homePath: join(root, 'home'), dshHome: join(root, 'dsh'), credentialHash: 'a'.repeat(64), gatewayCredential: '{}',
          signal: controller.signal, beforeAllocation: async () => { allocated = true },
        }))
        await witness(); controller.abort(new Error('startup cancelled'))
        assert.equal((await bounded(request, 2000)).error?.reason, 'cancelled')
        await closed(); assert.equal(allocated, false)
        transcript.push('Cancelling LocalLauncher closes its uncooperative identity client before any Runtime allocation.')
      })
    },
    async deadline() {
      await scenario({}, async ({ start, witness, closed }) => {
        const request = start(localKernelBootId())
        await witness()
        assert.equal((await bounded(request, 10_000)).error?.signal, 'SIGKILL')
        await closed()
        transcript.push('The boot identity command deadline closes a SIGTERM-ignoring native client before reporting failure.')
      })
    },
  }
  assert.ok(selected === 'all' || Object.hasOwn(cases, selected))
  for (const name of selected === 'all' ? Object.keys(cases) : [selected]) await cases[name]()
  const expected = (await readFile(new URL('../expected/local-boot-identity.expected.md', import.meta.url), 'utf8')).trimEnd().split('\n')
  const actual = transcript.join('\n') + '\n'
  assert.equal(actual, (selected === 'all' ? expected : [expected[Object.keys(cases).indexOf(selected)]]).join('\n') + '\n')
  process.stdout.write(actual)
} finally {
  childProcess.execFile = originalExecFile; syncBuiltinESMExports()
  Object.defineProperty(process, 'platform', platform)
  if (originalDatabase === undefined) delete process.env.HGW_DATABASE_URL; else process.env.HGW_DATABASE_URL = originalDatabase
}
