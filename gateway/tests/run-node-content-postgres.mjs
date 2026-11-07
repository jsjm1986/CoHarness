/** Run the physical-volume checks in a disposable PostgreSQL cluster with PGDATA on this computer. */
import { spawn } from 'node:child_process'
import { randomBytes, randomUUID } from 'node:crypto'
import { appendFile, mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { setTimeout } from 'node:timers/promises'
import { Client } from 'pg'

const gateway = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const legacy = process.argv.includes('--legacy')
const entry = process.argv.includes('--entry')
const recovery=process.argv.includes('--recovery')
const activity=process.argv.includes('--activity')
const operations=process.argv.includes('--operations')
if (recovery && !process.env.HGW_TEST_RESTIC) throw new Error('--recovery requires an installed restic executable in HGW_TEST_RESTIC.')
if (process.argv.slice(2).some(arg=>!['--legacy','--entry','--recovery','--activity','--operations'].includes(arg)) || [legacy,entry,recovery,activity,operations].filter(Boolean).length>1) throw new Error('Select --legacy, --entry, --recovery, --activity or --operations.')
const binaries = process.env.HGW_TEST_PG_BINDIR

const directory = await mkdtemp(join(await realpath(tmpdir()), 'hgw-node-content-'))
const pgdata = join(directory, 'pgdata')
const container = 'hgw-node-content-' + randomUUID()
const ownedOperationsDb=operations?randomUUID():null
const password = randomBytes(24).toString('hex')
const dockerEnv = { ...process.env, POSTGRES_PASSWORD: password }
function run(command, args, options = {}) {
  return new Promise((accept, reject) => {
    const child = spawn(command, args, { cwd: gateway, env: dockerEnv, ...options })
    let output = ''
    child.stdout?.on('data', chunk => { output += chunk })
    child.stderr?.on('data', chunk => { output += chunk })
    child.once('error', reject)
    child.once('close', code => code === 0 ? accept(output) : reject(new Error(command + ' exited ' + code + '\n' + output.replaceAll(password, '[redacted]'))))
  })
}
let created = false
let socketDirectory
try {
  await mkdir(pgdata, { mode: 0o700 })
  if (process.getuid === undefined || process.getgid === undefined) throw new Error('Run this fixture on a POSIX host with a local PostgreSQL Docker image.')
  let url
  if (binaries) {
    const socket=await mkdtemp(join('/tmp','hgw-pg-socket-'))
    socketDirectory=socket
    const secret=join(directory,'init.secret')
    await writeFile(secret,password+'\n',{mode:0o600})
    await run(join(binaries,'initdb'),['-D',pgdata,'--username=postgres','--auth=scram-sha-256','--encoding=UTF8','--no-locale','--wal-segsize=1','--no-sync','--pwfile',secret])
    await appendFile(join(pgdata,'postgresql.conf'),"\nlisten_addresses=''\nunix_socket_directories='"+socket.replaceAll("'","''")+"'\nshared_buffers='16MB'\nmax_connections=22\nmax_wal_size='24MB'\nmin_wal_size='2MB'\n")
    await run(join(binaries,'pg_ctl'),['-w','-D',pgdata,'-l',join(directory,'postgres.log'),'start'])
    created=true
    url=new URL('postgresql://postgres@localhost/postgres')
    url.searchParams.set('host',socket)
  } else {
    await run('docker', ['run','--detach','--pull=never','--name',container,'--memory','256m','--cpus','1',
      '--user',process.getuid()+':'+process.getgid(),'-e','POSTGRES_PASSWORD','-e','POSTGRES_INITDB_ARGS=--wal-segsize=1','-p','127.0.0.1::5432',
      '--mount','type=bind,src='+pgdata+',dst=/var/lib/postgresql/data','postgres:17.6-bookworm',
      '-c','shared_buffers=16MB','-c','max_connections=22','-c','max_wal_size=24MB','-c','min_wal_size=2MB'])
    created=true
    const address=(await run('docker',['port',container,'5432/tcp'])).trim()
    if (!/^127\.0\.0\.1:\d+$/u.test(address)) throw new Error('The disposable database must only listen on host loopback.')
    url=new URL('postgresql://postgres@'+address+'/postgres')
  }
  url.password=password
  const deadline=Date.now()+60000
  let setup
  while (!setup) {
    const candidate=new Client({connectionString:url.href,connectionTimeoutMillis:1000})
    try { await candidate.connect(); setup=candidate }
    catch (error) {
      await candidate.end()
      if (Date.now()>=deadline) throw new Error('Disposable PostgreSQL did not become ready.',{cause:error})
      await setTimeout(250)
    }
  }
  try { await setup.query('CREATE DATABASE hgw_governance_test'); if(ownedOperationsDb)await setup.query("COMMENT ON DATABASE hgw_governance_test IS '"+ownedOperationsDb+"'"); await setup.query('CREATE DATABASE hgw_node_content_test'); if(recovery) await setup.query('CREATE DATABASE hgw_replacement_content_test') }
  finally { await setup.end() }
  await mkdir(join(pgdata,'harness-node-content-proofs'), { mode: 0o700 })
  url.pathname = '/hgw_governance_test'
  const governanceUrl = url.href
  url.pathname = '/hgw_node_content_test'
  const suites=[activity?'tests/node-resource-budget-postgres.spec.ts':recovery?'tests/peer-backup-takeover-postgres.spec.ts':'tests/node-content-postgres.spec.ts']
  if (!activity && !recovery) suites.push('tests/archive-pool-postgres.spec.ts', 'tests/node-content-discard-postgres.spec.ts')
  if (legacy) suites.push('tests/conversation-runtime-namespace-postgres.spec.ts','tests/execution-runtime-isolation-postgres.spec.ts',
    'tests/project-activity-postgres.spec.ts','tests/project-progress-postgres.spec.ts')
  const command=operations?[join(gateway,'tests/run-built-node-service.mjs')]:entry?[join(gateway,'tests/fixtures/physical-project-gateway.mjs')]:
    [join(gateway,'node_modules/vitest/vitest.mjs'),'run',...suites,'--maxWorkers=1']
  await run(process.execPath, command, {
    stdio: 'inherit', env: { ...process.env, ...(operations?{HGW_TEST_VERSIONED_OPERATIONS:process.env.HGW_TEST_VERSIONED_OPERATIONS??'1',HGW_TEST_OWNED_OPERATIONS_DATABASE:ownedOperationsDb}:{}), HGW_TEST_DATABASE_URL: governanceUrl, HGW_TEST_NODE_CONTENT_DATABASE_URL: url.href, HGW_TEST_NODE_CONTENT_PGDATA: pgdata },
  })
} finally {
  try {
    if (created) {
      if (binaries) await run(join(binaries,'pg_ctl'),['-w','-D',pgdata,'stop','-m','fast'])
      else await run('docker',['rm','--force',container])
    }
  } finally {
    if (socketDirectory) await rm(socketDirectory,{recursive:true,force:true})
    await rm(directory,{recursive:true,force:true})
  }
}
