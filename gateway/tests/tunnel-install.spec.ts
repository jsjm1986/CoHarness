/** Tunnel discovery and failed downloads release their children, streams and private files. */
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile, chmod } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type { WriteStream } from 'node:fs'
import { finished } from 'node:stream/promises'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { installCloudflared, resolveCloudflared } from '../src/tunnel-supervisor.ts'

const { writeStream } = vi.hoisted(() => ({ writeStream: vi.fn<typeof import('node:fs').createWriteStream>() }))
vi.mock('node:fs', async (original) => ({ ...await original<typeof import('node:fs')>(), createWriteStream: writeStream }))
const roots: string[] = []
beforeEach(async () => {
  writeStream.mockReset()
  writeStream.mockImplementation((await vi.importActual<typeof import('node:fs')>('node:fs')).createWriteStream)
})
afterEach(async () => {
  vi.unstubAllEnvs()
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})
async function temporaryRoot() {
  const root = await mkdtemp(join(tmpdir(), 'tunnel-install-')); roots.push(root); return root
}

it.skipIf(process.platform === 'win32')('excludes deployment credentials when executing the selected binary for its version', async () => {
  const root = await temporaryRoot(), binary = join(root, 'cloudflared.mjs'), observation = join(root, 'environment.json')
  await writeFile(binary, `#!${process.execPath}\nimport { writeFileSync } from 'node:fs';
writeFileSync(${JSON.stringify(observation)}, JSON.stringify(Object.fromEntries(
 ['HGW_DATABASE_URL', 'DATABASE_URL', 'CLOUD_CREDENTIALS', 'TUNNEL_TOKEN'].map(name => [name, Object.hasOwn(process.env, name)]))));
console.log('cloudflared version fixture');\n`)
  await chmod(binary, 0o700)
  for (const key of ['HGW_DATABASE_URL', 'DATABASE_URL', 'CLOUD_CREDENTIALS', 'TUNNEL_TOKEN']) vi.stubEnv(key, 'synthetic-not-a-credential')
  expect(await resolveCloudflared({ envPath: binary, stateDir: root, which: async () => null })).toMatchObject({ path: binary, version: 'fixture' })
  const presence: unknown = JSON.parse(await readFile(observation, 'utf8'))
  expect(presence).toEqual({ HGW_DATABASE_URL: false, DATABASE_URL: false, CLOUD_CREDENTIALS: false, TUNNEL_TOKEN: false })
  const locator = join(root, 'which'), lookup = join(root, 'lookup.json')
  await writeFile(locator, `#!${process.execPath}\nimport { writeFileSync } from 'node:fs';
writeFileSync(${JSON.stringify(lookup)}, JSON.stringify({ databasePresent: Object.hasOwn(process.env, 'HGW_DATABASE_URL') }));
console.log(${JSON.stringify(binary)});\n`)
  await chmod(locator, 0o700)
  vi.stubEnv('PATH', `${root}:${process.env.PATH ?? ''}`)
  expect(await resolveCloudflared({ stateDir: root })).toMatchObject({ path: binary, version: 'fixture', source: 'path' })
  const lookupPresence: unknown = JSON.parse(await readFile(lookup, 'utf8'))
  expect(lookupPresence).toEqual({ databasePresent: false })
})

it.skipIf(process.platform === 'win32')('confirms native version-probe closure before returning cancellation', async () => {
  const root = await temporaryRoot(), binary = join(root, 'blocked-version.mjs'), observation = join(root, 'probe.json')
  await writeFile(binary, `#!${process.execPath}\nimport { createServer } from 'node:http';
import { writeFileSync } from 'node:fs'; import { randomUUID } from 'node:crypto';
const token = randomUUID(); const server = createServer((req, res) => res.end(req.url === '/' + token ? token : 'unknown probe'));
server.listen(0, '127.0.0.1', () => writeFileSync(${JSON.stringify(observation)}, JSON.stringify({
url: 'http://127.0.0.1:' + server.address().port + '/' + token, token })));\n`)
  await chmod(binary, 0o700)
  const controller = new AbortController()
  const request = resolveCloudflared({ envPath: binary, stateDir: root, which: async () => null, signal: controller.signal })
  const result = request.then(value => ({ value }), (error: unknown) => ({ error }))
  let witness: { url: string; token: string } | undefined
  try {
    await expect.poll(async () => {
      try {
        const parsed: unknown = JSON.parse(await readFile(observation, 'utf8'))
        if (typeof parsed !== 'object' || parsed === null || !('url' in parsed) || !('token' in parsed)
          || typeof parsed.url !== 'string' || typeof parsed.token !== 'string') throw new Error('Malformed probe witness')
        witness = { url: parsed.url, token: parsed.token }; return true
      } catch (error) { if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return false; throw error }
    }, { timeout: 20000 }).toBe(true)
    controller.abort(new Error('fixture probe cancelled'))
    expect(await result).toMatchObject({ error: { message: 'fixture probe cancelled' } })
    if (witness === undefined) throw new Error('Native probe did not publish its endpoint')
    let response: string | undefined
    try { response = await (await fetch(witness.url)).text() }
    catch (error) {
      if (!(error instanceof TypeError && error.cause instanceof Error && 'code' in error.cause
        && ['ECONNREFUSED', 'ECONNRESET'].includes(String(error.cause.code)))) throw error
    }
    expect(response).not.toBe(witness.token)
  } finally {
    controller.abort(new Error('fixture finished'))
    await Promise.allSettled([request])
  }
})

it('cancels an unsuccessful HTTP response body before reporting download failure', async () => {
  const root = await temporaryRoot()
  let cancelled = false
  const body = new ReadableStream<Uint8Array>({ cancel() { cancelled = true } })
  await expect(installCloudflared(root, async () => new Response(body, { status: 503 }))).rejects.toMatchObject({ code: 'download-failed' })
  expect(cancelled).toBe(true)
})

it('cancels the download reader when the destination cannot open', async () => {
  const root = await temporaryRoot()
  const actual = await vi.importActual<typeof import('node:fs')>('node:fs')
  writeStream.mockImplementationOnce(() => actual.createWriteStream(join(root, 'missing', 'archive')))
  let cancelled = false
  const body = new ReadableStream<Uint8Array>({
    pull(controller) { controller.enqueue(new Uint8Array(64 * 1024)) },
    cancel() { cancelled = true },
  })
  await expect(installCloudflared(root, async () => new Response(body))).rejects.toMatchObject({ code: 'ENOENT' })
  expect(cancelled).toBe(true)
})

it('closes the archive before returning an upstream read failure', async () => {
  const root = await temporaryRoot()
  const actual = await vi.importActual<typeof import('node:fs')>('node:fs')
  let sink: WriteStream | undefined
  writeStream.mockImplementationOnce((path, options) => { sink = actual.createWriteStream(path, options); return sink })
  const body = new ReadableStream<Uint8Array>({ start(controller) { controller.error(new Error('fixture upstream failed')) } })
  try {
    await expect(installCloudflared(root, async () => new Response(body))).rejects.toThrow('fixture upstream failed')
    expect(sink?.closed).toBe(true)
  } finally {
    if (sink !== undefined) { sink.destroy(); await Promise.allSettled([finished(sink)]) }
  }
})

it('stages on the destination filesystem and preserves an installed binary after failure', async () => {
  const root = await temporaryRoot(), bin = join(root, 'bin')
  await mkdir(bin)
  const target = join(bin, process.platform === 'win32' ? 'cloudflared.exe' : 'cloudflared')
  await writeFile(target, 'existing binary')
  await expect(installCloudflared(root, async () => {
    expect((await readdir(bin)).filter(name => name.startsWith('.cloudflared-'))).toHaveLength(1)
    throw new Error('fixture download refused')
  })).rejects.toThrow('fixture download refused')
  expect(await readFile(target, 'utf8')).toBe('existing binary')
  expect(await readdir(bin)).toEqual([process.platform === 'win32' ? 'cloudflared.exe' : 'cloudflared'])
})

it('cancels an accepted download and closes its archive before removing staging', async () => {
  const root = await temporaryRoot(), controller = new AbortController()
  let entered!: () => void, cancelled = false
  const reading = new Promise<void>(resolve => { entered = resolve })
  const body = new ReadableStream<Uint8Array>({ pull() { entered() }, cancel() { cancelled = true } })
  const request = installCloudflared(root, async () => new Response(body), controller.signal)
  await reading
  const rejected = expect(request).rejects.toMatchObject({ name: 'AbortError' })
  controller.abort(); await rejected
  expect(cancelled).toBe(true)
  expect(await readdir(join(root, 'bin'))).toEqual([])
})

it('preserves the installed binary when downloaded bytes do not match the release pin', async () => {
  const root = await temporaryRoot(), bin = join(root, 'bin')
  await mkdir(bin)
  const name = process.platform === 'win32' ? 'cloudflared.exe' : 'cloudflared', target = join(bin, name)
  await writeFile(target, 'existing binary')
  await expect(installCloudflared(root, async () => new Response('fixture corrupted archive'))).rejects.toMatchObject({ code: 'checksum-mismatch' })
  expect(await readFile(target, 'utf8')).toBe('existing binary')
  expect(await readdir(bin)).toEqual([name])
})
