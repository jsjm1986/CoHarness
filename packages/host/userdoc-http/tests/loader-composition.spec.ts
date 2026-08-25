/** Real Loader composition for the streaming document route and its disposal. */
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import WebServer from '@deepseek-ai/dsh-host-webserver'
import * as Connection from '@deepseek-ai/dsh-client-connection'
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

async function load(): Promise<Context> {
  root = await mkdtemp(join(tmpdir(), 'dsh-userdoc-http-loader-'))
  const uploads = join(root, 'uploads')
  const config = join(root, 'cordis.yml')
  await writeFile(config, [
    "- name: '@deepseek-ai/dsh-host-webserver'",
    '  config:',
    "    host: '127.0.0.1'",
    '    port: 0',
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

describe('real Loader composition', () => {
  it('serves through Connection and removes the subtree when its owning plugin unloads', { timeout: 60_000 }, async () => {
    const ctx = await load()
    const origin = `http://127.0.0.1:${String(ctx.webServer.port)}`
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
})
