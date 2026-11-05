/** Four real command invocations expose only synthetic environment witnesses. */
import assert from 'node:assert/strict'
import { readFile, writeFile } from 'node:fs/promises'
import { join, resolve, sep } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const [mode, root, artifact, credentials] = process.argv.slice(2)
assert.ok(mode === 'src' || mode === 'lib')
const moduleUrl = mode === 'src' ? new URL('../../src/deployment-commands.ts', import.meta.url)
  : new URL('deployment-commands.js', pathToFileURL(resolve(artifact || fileURLToPath(new URL('../../lib/', import.meta.url))) + sep))
const { createDeploymentCommands } = await import(moduleUrl)
const executable = join(root, 'postgres-fixture.mjs'), report = join(root, 'children.jsonl')
await writeFile(executable, `import { appendFileSync } from 'node:fs'
const operation = process.argv[2] === 'dump' ? 'backup' : process.argv[2] === 'psql' ? 'restore'
  : process.argv.includes('--list') ? 'verify' : 'render'
const unrelatedSecretsAbsent = ['HGW_AUDIT_FIXTURE_SECRET','DSH_AUDIT_FIXTURE_SECRET','AUDIT_FIXTURE_API_KEY']
  .every(name => process.env[name] === undefined)
const desired = ${JSON.stringify(credentials === 'configured' ? {
  PGPASSWORD: 'synthetic-database-password', PGPASSFILE: join(root, 'synthetic-pgpass'), PGSSLKEY: join(root, 'synthetic-pgsslkey'),
} : {})}
const postgresCredentialPolicyHonored = ['PGPASSWORD','PGPASSFILE','PGSSLKEY'].every(name=>process.env[name]===desired[name])
  && process.env.PGDATABASE === 'fixture-db'
appendFileSync(${JSON.stringify(report)}, JSON.stringify({ operation, unrelatedSecretsAbsent, postgresCredentialPolicyHonored })+'\\n', { mode: 0o600 })
const marker = process.argv.find(value => value.startsWith('--hgw-connection-stdin-v1='))
let pending = Buffer.alloc(0), acknowledged = marker === undefined
for await (const chunk of process.stdin) {
  if (acknowledged) continue
  pending = Buffer.concat([pending, chunk])
  if (pending.length < 4 || pending.length < 4 + pending.readUInt32BE()) continue
  acknowledged = true
  process.stdout.write('hgw-pg-client/1 ' + marker.slice('--hgw-connection-stdin-v1='.length) + '\\n')
}
if(operation==='backup')process.stdout.write('synthetic database archive')
if(operation==='render')process.stdout.write('SELECT 1;\\n')
`, { mode: 0o600 })
const commands = createDeploymentCommands([process.execPath, executable, 'dump'],
  [process.execPath, executable, 'archive'], [process.execPath, executable, 'psql'])
const controller = new AbortController()
const backup = await commands.backup(join(root, 'backups'), 'postgresql://fixture@127.0.0.1/fixture', [], controller.signal)
await commands.verifyDump(backup.dumpPath, controller.signal, backup.sha256)
await commands.restoreDump(backup.dumpPath, 'postgresql://fixture@127.0.0.1/fixture', {
  signal: controller.signal, owner: { pid: 1, backendStart: '1', token: 'synthetic-owner' },
}, backup.sha256)
process.stdout.write(await readFile(report, 'utf8'))
