/** Maintenance commands keep connections off argv and admit SQL only after private-input readiness. */
import { chmod, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, expect, it, vi } from 'vitest'
import { createDeploymentCommands } from '../src/deployment-commands.ts'
import type { DeploymentDataLease } from '../src/postgres/deployment-lock.ts'

const fixture = fileURLToPath(new URL('./fixtures/pg-private-command.mjs', import.meta.url))
const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })
async function setup(mode = 'normal', timeoutMs = 10000) {
  const root = await mkdtemp(join(tmpdir(), 'hgw-private-pg-')); roots.push(root)
  const command = (kind: string) => [process.execPath, fixture, kind, root, mode]
  const commands = createDeploymentCommands(command('dump'), command('archive'), command('psql'),
    { command: command('adapter'), timeoutMs })
  const events = async (): Promise<Array<{ kind: string; phase: string; pid: number; args?: string[];
    connection?: string; initialTailBytes?: number; tail?: string }>> => {
    try { return (await readFile(join(root, 'events.jsonl'), 'utf8')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line)) }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error }
  }
  return { root, commands, command, events }
}
const connection = "postgresql://fixture:synthetic'行\\\n@localhost/db"
function lease(signal: AbortSignal): DeploymentDataLease {
  return { signal, owner: { pid: 1, backendStart: '1', token: 'fixture-lease' },
    async query() { throw new Error('The command fixture owns no database connection') },
    async [Symbol.asyncDispose]() {},
  }
}

it('keeps the exact connection in stdin and removes the acknowledgement from the archive', async () => {
  const { root, commands, events } = await setup()
  const backup = await commands.backup(join(root, 'backups'), connection, [])
  expect(await readFile(backup.dumpPath, 'utf8')).toBe('fixture custom archive\n')
  const observed = await events()
  expect(observed.find(row => row.phase === 'connection')).toMatchObject({ connection, initialTailBytes: 0 })
  expect(observed.find(row => row.phase === 'started')?.args?.join(' ')).not.toContain('postgresql:')
  expect(observed.find(row => row.phase === 'input-ended')?.tail).toBe('')
})

it.each(['bad-ack', 'no-ack', 'nonzero'])('refuses %s wrappers and removes partial backup artifacts', async mode => {
  const { root, commands } = await setup(mode)
  await expect(commands.backup(join(root, 'backups'), connection, [])).rejects.toThrow()
  expect(await readdir(join(root, 'backups'))).toEqual([])
})

it('retains the adapter diagnostic when connection resolution fails before acknowledgement', async () => {
  const { root, commands } = await setup('invalid-connection')
  await expect(commands.backup(join(root, 'backups'), connection, [])).rejects.toThrow('invalid connection input')
})

it('refuses a successful wrapper that closes its input before acknowledging a complete frame', async () => {
  const { root, commands } = await setup('closed-input')
  await expect(commands.backup(join(root, 'backups'), 'x'.repeat(512 * 1024), [])).rejects.toThrow('not acknowledged')
  expect(await readdir(join(root, 'backups'))).toEqual([])
})

it('reports a missing wrapper executable and removes its partial files', async () => {
  const { root, command } = await setup()
  const commands = createDeploymentCommands([join(root, 'missing')], command('archive'))
  await expect(commands.backup(join(root, 'backups'), connection, [])).rejects.toMatchObject({ code: 'ENOENT' })
  expect(await readdir(join(root, 'backups'))).toEqual([])
})

it('bounds an unacknowledged wrapper and joins its actual child exit', async () => {
  const { root, commands, events } = await setup('hang', 1000)
  await expect(commands.backup(join(root, 'backups'), connection, [])).rejects.toThrow('timed out')
  const started = (await events()).find(row => row.phase === 'started')
  expect(started).toBeDefined()
  expect(() => process.kill(started!.pid, 0)).toThrow()
})

it('cancels before readiness, joins the wrapper and never releases restore SQL to it', async () => {
  const { root, commands, command, events } = await setup()
  const backup = await commands.backup(join(root, 'backups'), connection, [])
  const controller = new AbortController()
  const wrapped = createDeploymentCommands(command('dump'), command('archive'),
    [process.execPath, fixture, 'psql', root, 'hang'])
  const restoring = wrapped.restoreDump(backup.dumpPath, connection, lease(controller.signal), backup.sha256)
  const rejected = expect(restoring).rejects.toThrow('fixture cancelled')
  try {
    let pid = 0
    await vi.waitFor(async () => {
      const admitted = (await events()).find(row => row.kind === 'psql' && row.phase === 'connection')
      expect(admitted).toMatchObject({ initialTailBytes: 0 })
      pid = admitted!.pid
    })
    controller.abort(new Error('fixture cancelled'))
    await rejected
    expect(() => process.kill(pid, 0)).toThrow()
    expect((await events()).some(row => row.kind === 'psql' && row.phase === 'input-ended')).toBe(false)
  } finally { controller.abort(); await Promise.allSettled([restoring]) }
})

it('streams restore SQL after readiness and retains both transaction lease checks', async () => {
  const { root, commands, events } = await setup()
  const backup = await commands.backup(join(root, 'backups'), connection, [])
  await commands.restoreDump(backup.dumpPath, connection, lease(new AbortController().signal), backup.sha256)
  const received = (await events()).find(row => row.kind === 'psql' && row.phase === 'input-ended')!
  expect(received.tail).toContain('SELECT 1;')
  expect(received.tail?.match(/restore coordinating data lease is no longer active/gu)).toHaveLength(2)
  expect(received.tail).not.toContain(connection)
})

it('pairs a case-insensitive Windows archive executable with its SQL sibling through the real wrapper pipes', async () => {
  const { root, commands, events, command } = await setup()
  const backup = await commands.backup(join(root, 'backups'), connection, [])
  const paired = createDeploymentCommands(command('dump'), [...command('paired'), 'PG_RESTORE.EXE'])
  await paired.restoreDump(backup.dumpPath, connection, lease(new AbortController().signal), backup.sha256)
  const started = (await events()).find(row => row.kind === 'psql' && row.phase === 'started')!
  expect(started.args).toContain('psql.exe')
  expect((await events()).find(row => row.kind === 'psql' && row.phase === 'input-ended')?.tail).toContain('SELECT 1;')
})

it('ends the readiness deadline after acknowledgement while the admitted command is still running', async () => {
  const { root, commands, events } = await setup('post-ack-hold', 1000)
  const controller = new AbortController()
  const backing = commands.backup(join(root, 'backups'), connection, [], controller.signal)
  try {
    await vi.waitFor(async () => { expect((await events()).some(row => row.phase === 'input-ended')).toBe(true) })
    // The elapsed deadline is the behavior under test; readiness itself is observed above.
    await new Promise(resolve => setTimeout(resolve, 1200))
    await writeFile(join(root, 'release'), '')
    expect(await readFile((await backing).dumpPath, 'utf8')).toBe('fixture custom archive\n')
  } finally { controller.abort(); await Promise.allSettled([backing]) }
})

it.skipIf(process.platform === 'win32')('resolves local native credentials before starting the client and removes ambient service selection', async () => {
  const { root, command } = await setup()
  const client = join(root, 'pg_dump'), report = join(root, 'native.json')
  await writeFile(client, `#!${process.execPath}\nconst fs=require('node:fs');
    fs.writeFileSync(${JSON.stringify(report)},JSON.stringify({args:process.argv.slice(2),password:process.env.PGPASSWORD,service:process.env.PGSERVICE}));
    process.stdout.write('native archive');\n`, { mode: 0o700 })
  await chmod(client, 0o700)
  const commands = createDeploymentCommands([client], command('archive'), undefined, { command: command('adapter'), timeoutMs: 10000 })
  const backup = await commands.backup(join(root, 'native-backups'), connection, [])
  expect(await readFile(backup.dumpPath, 'utf8')).toBe('native archive')
  const observed = JSON.parse(await readFile(report, 'utf8'))
  expect(observed.password).toBe("synthetic'行\\\n")
  expect(observed.service).toBeUndefined()
  expect(observed.args).toContain("user='fixture' dbname='db'")
  expect(observed.args.join(' ')).not.toContain('synthetic')
})

it.skipIf(process.platform === 'win32').each(['bad-metadata', 'overflow'])('refuses %s native metadata before any target client starts', async mode => {
  const { root, command } = await setup(mode)
  const target = join(root, 'pg_dump')
  const commands = createDeploymentCommands([target], command('archive'), undefined, { command: command('adapter'), timeoutMs: 10000 })
  await expect(commands.backup(join(root, 'backups'), connection, [])).rejects.toThrow(/metadata/u)
  expect(await readdir(join(root, 'backups'))).toEqual([])
})
