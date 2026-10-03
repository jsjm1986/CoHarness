/** Real Loader composition for the streaming document route and its disposal. */
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { EventEmitter } from 'node:events'
import type { IncomingMessage } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import WebServer from '@deepseek-ai/dsh-host-webserver'
import * as Connection from '@deepseek-ai/dsh-client-connection'
import LocalCredentials from '@deepseek-ai/dsh-credentials-local'
import LocalUserDocStore from '@deepseek-ai/dsh-userdoc-local'
import * as UserDocHttp from '../src/index.ts'

let root: string | undefined
let context: Context | undefined

afterEach(async () => {
  await context?.fiber.dispose()
  context = undefined
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined
})

async function load(compression: 'none' | 'gzip' = 'none'): Promise<Context> {
  root = await mkdtemp(join(tmpdir(), 'dsh-userdoc-http-loader-'))
  const uploads = join(root, 'uploads')
  const config = join(root, 'cordis.yml')
  await writeFile(config, [
    "- name: '@deepseek-ai/dsh-host-webserver'",
    '  config:',
    "    host: '127.0.0.1'",
    '    port: 0',
    `    compression: ${compression}`,
    "- name: '@deepseek-ai/dsh-credentials-local'",
    '  config:',
    `    path: '${join(root, '.credentials.yaml')}'`,
    '    watch: false',
    "- name: '@deepseek-ai/dsh-client-connection'",
    "- name: '@deepseek-ai/dsh-userdoc-local'",
    '  config:',
    `    uploadRoot: ${JSON.stringify(uploads)}`,
    "- name: '@deepseek-ai/dsh-host-userdoc-http'",
    '',
  ].join('\n'))
  context = new Context()
  context.baseUrl = pathToFileURL(root).href + '/'
  await context.plugin(Loader)
  context.loader.builtins.include = Include
  const modules = new Map<string, unknown>([
    ['@deepseek-ai/dsh-host-webserver', WebServer],
    ['@deepseek-ai/dsh-credentials-local', LocalCredentials],
    ['@deepseek-ai/dsh-client-connection', Connection],
    ['@deepseek-ai/dsh-userdoc-local', LocalUserDocStore],
    ['@deepseek-ai/dsh-host-userdoc-http', UserDocHttp],
  ])
  context.loader.internal = {
    version: 'v2',
    async import(specifier: string) {
      const module = modules.get(specifier)
      if (module === undefined) throw new Error(`unexpected Loader import: ${specifier}`)
      return module
    },
  } as unknown as NonNullable<typeof context.loader.internal>
  await context.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(config).href } })
  await context.loader.await()
  return context
}

/**
 * Exchange the process token in-process (no frontend row serves `/` here) and
 * return a fetch attaching the session cookie.
 */
function authenticatedFetch(ctx: Context, origin: string): typeof fetch {
  const url = new URL(ctx.connection.authenticatedUrl(origin))
  const headers = { host: url.host }
  const request = Readable.from([]) as unknown as IncomingMessage
  Object.assign(request, { url: `${url.pathname}${url.search}`, method: 'GET', headers })
  let setCookie: string | undefined
  const response = Object.assign(new EventEmitter(), {
    writeHead(_status: number, head?: Record<string, string>) {
      setCookie = head?.['set-cookie']
      return this
    },
    end() { return this },
  })
  ctx.connection.authorizeIndex(request, response)
  if (setCookie === undefined) throw new Error('browser token exchange did not set a cookie')
  const cookie = setCookie.split(';', 1)[0]!
  return (input, init) => {
    const requestHeaders = new Headers(init?.headers)
    requestHeaders.set('cookie', cookie)
    return globalThis.fetch(input, { ...init, headers: requestHeaders })
  }
}

describe('real Loader composition', () => {
  it('serves through Connection and removes the subtree when its owning plugin unloads', { timeout: 60_000 }, async () => {
    const ctx = await load()
    const origin = `http://127.0.0.1:${String(ctx.webServer.port)}`
    const fetch = authenticatedFetch(ctx, origin)
    const started = await fetch(`${origin}/api/documents/uploads`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ version: 1, name: 'loader.txt', directory: '', bytes: 6, fingerprint: 'loader' }),
    })
    const session = await started.json() as { uploadId: string }
    const data = new TextEncoder().encode('loader')
    const digest = createHash('sha256').update(data).digest('hex')
    await fetch(`${origin}/api/documents/uploads/${session.uploadId}/chunks/0`, {
      method: 'PUT',
      headers: {
        'content-range': 'bytes 0-5/6',
        'content-length': '6',
        'x-dsh-chunk-sha256': digest,
      },
      body: data,
    })
    const created = await fetch(`${origin}/api/documents/uploads/${session.uploadId}/complete`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ version: 1, sha256: digest }),
    })
    expect(created.status).toBe(202)
    let completed = await fetch(`${origin}/api/documents/uploads/${session.uploadId}`)
    for (let attempt = 0; completed.status === 202 && attempt < 50; attempt += 1) {
      await new Promise(resolve => setTimeout(resolve, 2))
      completed = await fetch(`${origin}/api/documents/uploads/${session.uploadId}`)
    }
    expect(completed.status).toBe(200)
    expect(await completed.json()).toMatchObject({ state: 'complete', ref: { name: 'loader.txt', bytes: 6 } })

    const entry = [...ctx.loader.entries()].find(item => item.options.name === '@deepseek-ai/dsh-host-userdoc-http')
    expect(entry?.fiber).toBeDefined()
    await entry!.fiber!.dispose()
    expect((await fetch(`${origin}/api/documents`)).status).toBe(404)
  })

  it('serves identity bytes with a declared length under gzip compression', { timeout: 60_000 }, async () => {
    const ctx = await load('gzip')
    const origin = `http://127.0.0.1:${String(ctx.webServer.port)}`
    const fetch = authenticatedFetch(ctx, origin)
    const started = await fetch(`${origin}/api/documents/uploads`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ version: 1, name: 'loader.bin', directory: '', bytes: 6, fingerprint: 'loader' }),
    })
    const session = await started.json() as { uploadId: string }
    const data = new TextEncoder().encode('loader')
    const digest = createHash('sha256').update(data).digest('hex')
    await fetch(`${origin}/api/documents/uploads/${session.uploadId}/chunks/0`, {
      method: 'PUT',
      headers: {
        'content-range': 'bytes 0-5/6',
        'content-length': '6',
        'x-dsh-chunk-sha256': digest,
      },
      body: data,
    })
    await fetch(`${origin}/api/documents/uploads/${session.uploadId}/complete`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ version: 1, sha256: digest }),
    })
    let completed = await fetch(`${origin}/api/documents/uploads/${session.uploadId}`)
    for (let attempt = 0; completed.status === 202 && attempt < 50; attempt += 1) {
      await new Promise(resolve => setTimeout(resolve, 2))
      completed = await fetch(`${origin}/api/documents/uploads/${session.uploadId}`)
    }
    const ref = (await completed.json() as { ref: { docId: string } }).ref

    const downloaded = await fetch(`${origin}/api/documents/content?id=${encodeURIComponent(ref.docId)}`)
    expect(downloaded.status).toBe(200)
    expect(downloaded.headers.get('content-encoding')).not.toBe('gzip')
    expect(downloaded.headers.get('content-length')).toBe('6')
    expect(downloaded.headers.get('cache-control')).toContain('no-transform')
    expect(await downloaded.text()).toBe('loader')
  })
})
