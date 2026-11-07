/** Real account-query children controlled by private files and the parent IPC channel. */
import { existsSync, readdirSync, writeFileSync, watch } from 'node:fs'
import { join } from 'node:path'
import { setImmediate as nextTurn } from 'node:timers/promises'

const [mode, root, implementation = 'src', timeout = '10000'] = process.argv.slice(2)
if (mode === 'id') {
  const directory = process.env.ACCOUNT_LOOKUP_FIXTURE
  process.on('SIGTERM', () => {})
  writeFileSync(join(directory, `${process.pid}.observed.json`), JSON.stringify({
    gatewaySetting: process.env.HGW_ACCOUNT_LOOKUP_FIXTURE !== undefined,
    credential: process.env.ACCOUNT_LOOKUP_TOKEN !== undefined,
    locale: process.env.LC_ALL,
    args: JSON.parse(process.env.ACCOUNT_LOOKUP_ARGS),
  }))
  writeFileSync(join(directory, `${process.pid}.ready`), '')
  const released = () => existsSync(join(directory, 'release'))
  if (!released()) await new Promise(resolve => {
    const watcher = watch(directory, () => { if (released()) { watcher.close(); resolve() } })
    if (released()) { watcher.close(); resolve() }
  })
  process.stdout.write('1001\n')
} else {
  const extension = implementation === 'lib' ? 'js' : 'ts'
  const { documentRuntimeAccess } = await import(`../../${implementation}/document-storage.${extension}`)
  const { prepareProjectRuntimeData } = await import(`../../${implementation}/project-runtime-data.${extension}`)
  Object.defineProperty(process, 'platform', { value: 'linux' })
  process.getuid = () => 0
  process.env.PATH = root
  process.env.ACCOUNT_LOOKUP_FIXTURE = root
  const controller = new AbortController()
  const finish = Promise.withResolvers()
  process.on('message', message => {
    if (message === 'ping') process.send({ type: 'pong' })
    if (message === 'cancel') controller.abort(new Error('account lookup cancelled'))
    if (message === 'finish') finish.resolve()
  })
  try {
    const operation = mode === 'document'
      ? documentRuntimeAccess('fixture-account', true, Number(timeout), controller.signal)
      : prepareProjectRuntimeData({ projectRuntimesRoot: root, readinessTimeoutMs: Number(timeout) }, 27, 'fixture-account', 'web', controller.signal)
    try {
      await operation
      process.send({ type: 'settled', outcome: 'resolved' })
    } catch (error) {
      const survivingHelpers = readdirSync(root).filter(name => name.endsWith('.ready')).map(name => Number(name.split('.')[0])).filter(pid => {
        try { process.kill(pid, 0); return true } catch { return false }
      })
      process.send({ type: 'settled', outcome: 'rejected', message: error.message, survivingHelpers })
    }
    await finish.promise
  } finally {
    writeFileSync(join(root, 'release'), '')
    await nextTurn()
    process.disconnect()
  }
}
