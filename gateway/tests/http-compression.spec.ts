/** Dynamic Brotli/gzip negotiation and response compression for Gateway JSON/HTML routes. */
import { createServer, request as httpRequest, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { brotliDecompressSync, gunzipSync } from 'node:zlib'
import { afterEach, describe, expect, it } from 'vitest'
import { isCompressibleContentType, preferredCompression, sendCompressed } from '../src/http-compression.ts'

const servers: Server[] = []
afterEach(async () => {
  for (const server of servers.splice(0).reverse()) {
    await new Promise<void>(resolve => { server.closeAllConnections(); server.close(() => resolve()) })
  }
})

async function listen(server: Server): Promise<number> {
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
  servers.push(server)
  return (server.address() as AddressInfo).port
}

function rawGet(port: number, path: string, headers: Record<string, string> = {}, method = 'GET') {
  return new Promise<{ status: number; headers: Record<string, string | string[] | undefined>; body: Buffer }>((resolve, reject) => {
    const req = httpRequest({ hostname: '127.0.0.1', port, path, method, headers }, res => {
      const chunks: Buffer[] = []
      res.on('data', chunk => { chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)) })
      res.once('end', () => { resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks) }) })
    })
    req.once('error', reject)
    req.end()
  })
}

describe('preferredCompression', () => {
  it('selects Brotli over gzip on equal priority and honors explicit quality weights', () => {
    expect(preferredCompression(undefined)).toBeUndefined()
    expect(preferredCompression('')).toBeUndefined()
    expect(preferredCompression('gzip, deflate, br')).toBe('br')
    expect(preferredCompression('gzip;q=0.9, br;q=0.5')).toBe('gzip')
    expect(preferredCompression('br;q=0, gzip;q=1')).toBe('gzip')
    expect(preferredCompression('br;q=0, gzip;q=0')).toBeUndefined()
    expect(preferredCompression('*')).toBe('br')
    expect(preferredCompression('br;q=0, *;q=0.5')).toBe('gzip')
    expect(preferredCompression('deflate')).toBeUndefined()
  })

  it('excludes streaming and binary content types from dynamic compression', () => {
    expect(isCompressibleContentType('application/json; charset=utf-8')).toBe(true)
    expect(isCompressibleContentType('text/html')).toBe(true)
    expect(isCompressibleContentType('text/event-stream')).toBe(false)
    expect(isCompressibleContentType('application/x-ndjson')).toBe(false)
    expect(isCompressibleContentType('application/octet-stream')).toBe(false)
  })
})

describe('sendCompressed', () => {
  it('compresses large JSON with br/gzip, preserves vary tokens, skips small bodies, and supports HEAD', async () => {
    const bigJson = JSON.stringify({ items: Array.from({ length: 120 }, (_, i) => ({ id: i, name: `session-${i}`, path: '/workspace/project' })) })
    const smallJson = JSON.stringify({ ok: true })
    const port = await listen(createServer(async (req, res) => {
      if (req.url === '/big') {
        res.setHeader('cache-control', 'no-store')
        res.setHeader('vary', 'accept')
        await sendCompressed(req, res, 200, bigJson, 'application/json')
      } else if (req.url === '/small') {
        await sendCompressed(req, res, 200, smallJson, 'application/json')
      } else {
        await sendCompressed(req, res, 200, bigJson, 'application/x-ndjson')
      }
    }))

    const br = await rawGet(port, '/big', { 'accept-encoding': 'gzip, br' })
    expect(br.status).toBe(200)
    expect(br.headers['content-encoding']).toBe('br')
    expect(br.headers.vary).toBe('accept, accept-encoding')
    expect(br.headers['cache-control']).toBe('no-store')
    expect(br.body.byteLength).toBeLessThan(Buffer.byteLength(bigJson) / 4)
    expect(brotliDecompressSync(br.body).toString('utf8')).toBe(bigJson)

    const gz = await rawGet(port, '/big', { 'accept-encoding': 'gzip' })
    expect(gz.headers['content-encoding']).toBe('gzip')
    expect(gunzipSync(gz.body).toString('utf8')).toBe(bigJson)

    const head = await rawGet(port, '/big', { 'accept-encoding': 'br' }, 'HEAD')
    expect(head.status).toBe(200)
    expect(head.headers['content-encoding']).toBe('br')
    expect(head.body.byteLength).toBe(0)

    const small = await rawGet(port, '/small', { 'accept-encoding': 'br, gzip' })
    expect(small.headers['content-encoding']).toBeUndefined()
    expect(small.body.toString('utf8')).toBe(smallJson)

    const ndjson = await rawGet(port, '/stream', { 'accept-encoding': 'br, gzip' })
    expect(ndjson.headers['content-encoding']).toBeUndefined()
    expect(ndjson.body.toString('utf8')).toBe(bigJson)
  })
})
