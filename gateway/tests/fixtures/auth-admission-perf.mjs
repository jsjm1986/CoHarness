/** Plain-Node child for built authentication timing and process-memory samples. */
import { postgresTestDatabaseUrl } from '../postgres-test-database.mjs'
import { randomUUID } from 'node:crypto'
import { readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { performance } from 'node:perf_hooks'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { createPostgresPool } from '../../lib/postgres/database.js'

const databaseUrl = postgresTestDatabaseUrl(process.env.HGW_TEST_DATABASE_URL)
if (databaseUrl === undefined) {
  throw new Error('Authentication diagnostic child requires a disposable test database')
}
let inputText = ''
for await (const chunk of process.stdin) inputText += String(chunk)
const input = JSON.parse(inputText)
const { revision, operation } = input
if ((revision !== 'before' && revision !== 'current') || (operation !== 'login' && operation !== 'validate')) {
  throw new Error('Authentication diagnostic variant is invalid')
}
const median = values => values.toSorted((left, right) => left - right)[Math.floor(values.length / 2)]
const artifact = fileURLToPath(new URL('../../lib/postgres/auth-service.js', import.meta.url))
const baseline = join(fileURLToPath(new URL('../../lib/postgres/', import.meta.url)), `.auth-before-${randomUUID()}.js`)
let moduleUrl = pathToFileURL(artifact).href
try {
  if (revision === 'before') {
    const source = await readFile(artifact, 'utf8')
    const checks = /^\s*AND \(SELECT status FROM harness\.organizations WHERE id=\$1\)='active'/gm
    const canonical = /const canonical = await this\.context\.pool\.query\(\s*'SELECT lower\(\$1::text\) username', \[username\]\);\s*const canonicalUsername = canonical\.rows\[0\]\.username;/
    if ([...source.matchAll(checks)].length !== 3 || !canonical.test(source)) {
      throw new Error('Rebuild Gateway: authentication baseline must remove exactly three organization checks and one canonicalization query')
    }
    await writeFile(baseline, source.replace(checks, '').replace(canonical, 'const canonicalUsername = username.toLowerCase();'), { flag: 'wx' })
    moduleUrl = pathToFileURL(baseline).href
  }
  const { PostgresAuthService } = await import(moduleUrl)
  const pool = createPostgresPool(databaseUrl, { max: 1 })
  try {
    const auth = new PostgresAuthService({ ...input.context, pool }, input.config)
    const run = async () => {
      if (operation === 'validate') {
        if (await auth.validate(input.token) === null) throw new Error('Diagnostic cookie was rejected')
      } else {
        const result = await auth.login('perf-member', 'coharness-perf-password', '127.0.0.1', 'diagnostic')
        if (typeof result === 'string') throw new Error(`Diagnostic login was ${result}`)
      }
    }
    const operations = operation === 'validate' ? 200 : 20
    for (let index = 0; index < 10; index++) await run()
    const times = []
    for (let sample = 0; sample < 3; sample++) {
      const start = performance.now()
      for (let index = 0; index < operations; index++) await run()
      times.push((performance.now() - start) / operations)
    }
    if (globalThis.gc === undefined) throw new Error('Run diagnostic children with --expose-gc')
    globalThis.gc()
    process.stdout.write(JSON.stringify({ revision, operation, msPerCall: median(times),
      peakKiB: process.resourceUsage().maxRSS, steadyKiB: process.memoryUsage().rss / 1024 }) + '\n')
  } finally { await pool.end() }
} finally { if (revision === 'before') await rm(baseline, { force: true }) }
