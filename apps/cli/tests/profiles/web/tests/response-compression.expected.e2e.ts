/** Built Web-profile acceptance for negotiated asset encoding and unchanged decoded JavaScript. */

import { request } from 'node:http'
import { brotliDecompressSync, gunzipSync } from 'node:zlib'
import { expect, it } from 'vitest'
import { withDefaultWeb, webGet } from './default-web-process.ts'

/** Read encoded bytes directly; fetch would transparently decode them. */
function asset(url: URL, cookie: string, encoding: string, signal: AbortSignal) {
  return new Promise<{
    encoding: string | undefined
    vary: string | undefined
    body: Buffer
    status: number | undefined
  }>((resolve, reject) => {
    const req = request(url, { agent: false, signal, headers: { cookie, 'accept-encoding': encoding } }, (res) => {
      const chunks: Buffer[] = []
      res.on('data', (chunk: Buffer) => { chunks.push(chunk) })
      res.once('error', reject)
      res.once('end', () => {
        resolve({ encoding: res.headers['content-encoding'], vary: res.headers.vary, body: Buffer.concat(chunks), status: res.statusCode })
      })
    })
    req.once('error', reject)
    req.end()
  })
}

it('negotiates Brotli or gzip for the shipped PDF viewer with identical decoded bytes', async (test) => {
  await withDefaultWeb(test, async ({ url, request }) => {
    const auth = await webGet(url, test.signal)
    const cookie = auth.headers['set-cookie']?.[0]?.split(';', 1)[0]
    expect(cookie).toBeDefined()
    const entry = (await request('roster')).client.entries.find(row => row.id === '@deepseek-ai/dsh-client-ui-workbench')
    expect(entry).toBeDefined()
    const path = new URL('/plugins/@deepseek-ai/dsh-client-ui-workbench/client.pdf.js', url)
    path.searchParams.set('rev', entry!.rev)
    const identity = await asset(path, cookie!, 'identity', test.signal)
    expect(identity.status).toBe(200)
    expect(identity.encoding).toBeUndefined()
    expect(identity.body.length).toBeGreaterThan(1024)

    const brotli = await asset(path, cookie!, 'br, gzip', test.signal)
    expect(brotli.status).toBe(200)
    expect(brotli.encoding).toBe('br')
    expect(brotli.vary).toContain('Accept-Encoding')
    expect(brotliDecompressSync(brotli.body)).toEqual(identity.body)

    const gzip = await asset(path, cookie!, 'gzip, br;q=0.5', test.signal)
    expect(gzip.status).toBe(200)
    expect(gzip.encoding).toBe('gzip')
    expect(gunzipSync(gzip.body)).toEqual(identity.body)
  })
})
