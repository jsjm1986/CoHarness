/** Serial, keyless font-cache diagnostic over fresh processes loading the built Office provider. */
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { unzipSync, zipSync, type Zippable } from 'fflate'
import { z } from 'zod'
import { realOfficeBytes } from '../../../../apps/web/tests/office-fixture.ts'

const run = promisify(execFile)
const root = await mkdtemp(join(tmpdir(), 'dsh-office-font-perf-'))
const shared = join(root, 'metadata')
const input = join(root, 'input.docx')
const worker = join(root, 'worker.mjs')
const built = new URL('../lib/index.js', import.meta.url).href
const cordis = new URL('../../../../vendor/cordis/lib/index.js', import.meta.url).href
const sampleSchema = z.object({
  milliseconds: z.number().nonnegative(), rss: z.number().nonnegative(), maxRssKiB: z.number().nonnegative(),
  pdfBytes: z.number().positive(), pdfSha256: z.string().length(64), missingFonts: z.array(z.string()),
})
let joined = true
try {
  const archive: Zippable = {}
  for (const [name, bytes] of Object.entries(unzipSync(realOfficeBytes('docx', 'Arial')))) {
    archive[name] = [bytes, { mtime: new Date(2020, 0, 1) }]
  }
  const bytes = zipSync(archive, { level: 6 })
  await writeFile(input, bytes, { flag: 'wx', mode: 0o600 })
  await writeFile(worker, String.raw`
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { performance } from 'node:perf_hooks'
const job = JSON.parse(process.argv[2])
const { Context } = await import(job.cordis)
const office = await import(job.built)
const ctx = new Context()
const lifetime = new AbortController()
const stop = () => lifetime.abort(new Error('Diagnostic interrupted'))
process.once('SIGTERM', stop)
const start = performance.now()
try {
  await ctx.plugin(office.default, job.shared ? { fontMetadataCacheDirectory: job.shared } : {})
  const result = await ctx.officeToPdf.convert({ extension: 'docx', priority: 'foreground', source: {
    key: office.OfficeSourceKey('font-diagnostic'), version: 'fixed', bytes: job.bytes,
    read: async () => ({ bytes: await readFile(job.input), version: 'fixed' }),
  } }, AbortSignal.any([lifetime.signal, AbortSignal.timeout(90_000)]))
  await ctx.fiber.dispose()
  const milliseconds = performance.now() - start
  const pdf = Buffer.from(result.pdf)
  assert.ok(pdf.subarray(0, 5).equals(Buffer.from('%PDF-')))
  assert.ok(pdf.subarray(-2048).includes(Buffer.from('%%EOF')))
  process.stdout.write(JSON.stringify({ milliseconds, rss: process.memoryUsage().rss,
    maxRssKiB: process.resourceUsage().maxRSS, pdfBytes: pdf.length,
    pdfSha256: createHash('sha256').update(pdf).digest('hex'), missingFonts: result.missingFonts }) + String.fromCharCode(10))
} finally {
  process.removeListener('SIGTERM', stop)
  await ctx.fiber.dispose()
}
`, { flag: 'wx', mode: 0o600 })
  const samples = []
  for (const [index, cache] of ['shared-fill', 'private', 'shared', 'private', 'shared', 'private', 'shared'].entries()) {
    const childHome = join(root, `home-${String(index)}`)
    await mkdir(childHome, { mode: 0o700 })
    const env = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
      ['PATH', 'LANG', 'LC_ALL', 'LC_CTYPE', 'TZ', 'TMPDIR'].includes(key)))
    env.HOME = childHome
    if (process.platform === 'win32') {
      env.USERPROFILE = childHome
      env.LOCALAPPDATA = join(childHome, 'AppData', 'Local')
    }
    const job = { cordis, built, input, bytes: bytes.length, shared: cache === 'private' ? undefined : shared }
    let stdout: string
    try {
      joined = false
      const result = await run(process.execPath, [worker, JSON.stringify(job)], {
        env, cwd: root, timeout: 120_000, maxBuffer: 1024 * 1024, killSignal: 'SIGTERM',
      })
      joined = true
      stdout = result.stdout
    } catch (error) {
      joined = typeof error === 'object' && error !== null && 'signal' in error && error.signal === null
      throw error
    }
    samples.push({ cache, ...sampleSchema.parse(JSON.parse(stdout)) })
  }
  const metadata = await readFile(join(shared, 'font-metadata.json'))
  const first = samples[0]!
  assert.ok(samples.every(sample => JSON.stringify(sample.missingFonts) === JSON.stringify(first.missingFonts)))
  console.info(JSON.stringify({
    diagnostic: 'office-font-metadata', node: process.version, platform: process.platform, arch: process.arch,
    inputBytes: bytes.length, inputSha256: createHash('sha256').update(bytes).digest('hex'), samples,
    metadataBytes: metadata.length,
    clock: 'Fresh plain-Node built-provider process; imports and fixture setup excluded; admission, reads, conversion and disposal included',
    memory: 'Node process maximum RSS and endpoint RSS with caller PDF retained; native subprocess peak excluded; no forced GC',
    excludes: ['authentication', 'network', 'browser rendering', 'native subprocess memory', 'all-Runtime capacity'],
    functionalEvidence: 'workspace-office.e2e.ts owns rendered and selectable content; PDF hashes include engine metadata',
    timingThreshold: null,
  }, null, 2))
} finally {
  if (joined) await rm(root, { recursive: true, force: true })
  else console.error('Owned diagnostic directory retained after interrupted child:', root)
}
