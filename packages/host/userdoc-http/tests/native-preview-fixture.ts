/** Native-browser acceptance fixture using only generated documents and the production authenticated HTTP owner. */
import { Context } from '@deepseek-ai/cordis'
import * as Connection from '@deepseek-ai/dsh-client-connection'
import LocalCredentials from '@deepseek-ai/dsh-credentials-local'
import WebServer from '@deepseek-ai/dsh-host-webserver'
import LocalUserDocStore from '@deepseek-ai/dsh-userdoc-local'
import { createServer, type Server } from 'node:http'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import * as UserDocHttp from '../src/index.ts'

interface PreviewDocument {
  readonly name: string
  readonly mediaType: string
  readonly bytes: number
  readonly url: string
  readonly downloadUrl: string
}

/** Isolated authenticated Host and a different-origin parent for framing checks. */
export interface NativePreviewFixture {
  readonly origin: string
  readonly authenticatedUrl: string
  readonly crossOriginUrl: string
  readonly documents: Readonly<Record<'pdf' | 'fakePdf' | 'html' | 'svg' | 'text', PreviewDocument>>
  readonly close: () => Promise<void>
}

function pdfBytes(): Buffer {
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ]
  const drawing = 'BT /F1 20 Tf 40 720 Td (Document library PDF preview acceptance) Tj ET\n'
  objects.push(`<< /Length ${String(Buffer.byteLength(drawing))} >>\nstream\n${drawing}endstream`)
  let output = '%PDF-1.7\n'
  const offsets = [0]
  objects.forEach((object, index) => {
    offsets.push(Buffer.byteLength(output))
    output += `${String(index + 1)} 0 obj\n${object}\nendobj\n`
  })
  const xref = Buffer.byteLength(output)
  output += `xref\n0 ${String(objects.length + 1)}\n0000000000 65535 f \n`
  output += offsets.slice(1).map(offset => `${String(offset).padStart(10, '0')} 00000 n \n`).join('')
  output += `trailer\n<< /Size ${String(objects.length + 1)} /Root 1 0 R >>\nstartxref\n${String(xref)}\n%%EOF\n`
  return Buffer.from(output)
}

function closeServer(server: Server): Promise<void> {
  return new Promise((done, reject) => {
    server.close((error) => { if (error === undefined) done(); else reject(error) })
    server.closeIdleConnections()
  })
}

/**
 * Start an ephemeral loopback-only Host with its real Connection, store and document routes.
 * @returns native preview URLs and an awaited disposer removing all generated files.
 */
export async function startNativePreviewFixture(): Promise<NativePreviewFixture> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-native-preview-'))
  const ctx = new Context()
  let crossServer: Server | undefined
  let closing: Promise<void> | undefined
  const close = (): Promise<void> => closing ??= (async () => {
    try {
      if (crossServer !== undefined) await closeServer(crossServer)
      await ctx.fiber.dispose()
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })()
  try {
    await ctx.plugin(WebServer, { host: '127.0.0.1', port: 0, compression: 'none' })
    await ctx.plugin(LocalCredentials, { path: join(root, 'credentials.yaml'), watch: false })
    await ctx.plugin({ inject: Connection.inject, apply: Connection.apply })
    await ctx.plugin(LocalUserDocStore, { uploadRoot: join(root, 'documents'), uploadMinFreeBytes: 0 })
    await ctx.plugin({ inject: UserDocHttp.inject, apply: UserDocHttp.apply })
    const origin = `http://127.0.0.1:${String(ctx.webServer.port)}`
    const script = "parent.postMessage({ documentProbe: 'executed' }, '*')"
    const bodies = {
      pdf: { name: 'preview.pdf', data: pdfBytes() },
      fakePdf: { name: 'fake.pdf', data: Buffer.from(`<html><script>${script}</script>HTML disguised as PDF</html>`) },
      html: { name: 'preview.html', data: Buffer.from(`<html><script>${script}</script>HTML guard</html>`) },
      svg: { name: 'preview.svg', data: Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" onload="${script}"><text y="20">SVG guard</text></svg>`) },
      text: { name: 'preview.txt', data: Buffer.from('Plain text guard') },
    }
    const entries = await Promise.all(Object.entries(bodies).map(async ([kind, body]) => {
      const target = await ctx.userDocs.resolveTarget({ name: body.name })
      const ref = await ctx.userDocs.save(target, new ReadableStream<Uint8Array>({
        start(controller) { controller.enqueue(body.data); controller.close() },
      }))
      const address = `${origin}/api/documents/content?id=${encodeURIComponent(ref.docId)}`
      return [kind, { name: ref.name, mediaType: ref.mediaType, bytes: ref.bytes, url: `${address}&inline=1`, downloadUrl: address }]
    }))
    const documents = Object.fromEntries(entries) as NativePreviewFixture['documents']
    const page = (content: string): string => `<!doctype html><html><head><meta charset="utf-8"><title>Native document preview</title></head>
      <body><h1>Native document preview</h1><p id="probe">No document script executed</p>
      <script>addEventListener('message', event => { if (event.data?.documentProbe === 'executed') document.getElementById('probe').textContent = 'DOCUMENT SCRIPT EXECUTED' })</script>
      ${content}</body></html>`
    ctx.effect(() => ctx.webServer.registerFallback((req, res) => {
      if (!ctx.connection.authorizeIndex(req, res)) return
      const kind = new URL(req.url ?? '/', origin).searchParams.get('case') ?? 'pdf'
      const document = documents[kind as keyof typeof documents]
      if (document === undefined) { res.writeHead(404); res.end(); return }
      const links = Object.keys(documents).map(key => `<a href="/?case=${key}">${key}</a>`).join(' | ')
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
      res.end(page(`${links}<p><a href="${document.downloadUrl}">Download ${document.name}</a></p>
        <iframe width="900" height="720" title="${document.name}" src="${document.url}"></iframe>`))
    }), 'native preview fixture page')
    crossServer = createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
      res.end(page(`<h2>Different-origin parent: PDF must be blocked</h2>
        <iframe width="900" height="720" title="Cross-origin PDF" src="${documents.pdf.url}"></iframe>`))
    })
    await new Promise<void>((done) => { crossServer!.listen(0, '127.0.0.1', done) })
    const address = crossServer.address()
    if (address === null || typeof address === 'string') throw new Error('native preview fixture has no TCP address')
    return { origin, authenticatedUrl: ctx.connection.authenticatedUrl(origin), crossOriginUrl: `http://127.0.0.1:${String(address.port)}/`, documents, close }
  } catch (error) {
    await close()
    throw error
  }
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const fixture = await startNativePreviewFixture()
  const stop = (): void => { void fixture.close().then(() => { process.exitCode = 0 }) }
  process.once('SIGINT', stop)
  process.once('SIGTERM', stop)
  console.log(JSON.stringify({ pid: process.pid, ...fixture, close: undefined }))
}
