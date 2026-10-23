/** Real PDF.js Worker decoders consume the same packaged resource bytes as browser previews. */
import { readFile, readdir } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { createRequire } from 'node:module'
import { Worker as Thread, type Transferable } from 'node:worker_threads'
import { expect, it } from 'vitest'
import { getDocument, PDFWorker } from 'pdfjs-dist/legacy/build/pdf.mjs'
import { createPdfBinaryDataFactory, type PdfAssetKind, type PdfBinaryDataFactory } from '../src/client/pdf/assets.ts'
import { renderPdfPage } from '../src/client/pdf/document.ts'
import { pdfResourceFixture } from './pdf-resource-fixture.ts'

const require = createRequire(import.meta.url)
const root = dirname(require.resolve('pdfjs-dist/package.json'))
const directories = { cMapUrl: 'cmaps', standardFontDataUrl: 'standard_fonts', wasmUrl: 'wasm' } as const

it.each(['vector', 'standard', 'cjk', 'jpx', 'jbig2'] as const)('renders a real %s PDF through on-demand binary groups', async (kind) => {
  const thread = new Thread(new URL('./pdf-worker.fixture.mjs', import.meta.url), {
    workerData: { workerUrl: import.meta.resolve('pdfjs-dist/legacy/build/pdf.worker.mjs') },
  })
  const ready = Promise.withResolvers<undefined>(), failed = Promise.withResolvers<never>()
  thread.once('message', () => { ready.resolve(undefined) })
  thread.once('error', (error) => { failed.reject(error) })
  const listeners = new Map<EventListener, (data: unknown) => void>()
  const port = {
    postMessage: (message: unknown, transfer: readonly Transferable[]) => { thread.postMessage(message, transfer) },
    addEventListener: (_type: string, listener: EventListener) => {
      const forward = (data: unknown): void => { listener({ data } as MessageEvent<unknown>) }
      listeners.set(listener, forward); thread.on('message', forward)
    },
    removeEventListener: (_type: string, listener: EventListener) => {
      const forward = listeners.get(listener)
      if (forward !== undefined) thread.off('message', forward)
      listeners.delete(listener)
    },
  }
  const controller = new AbortController(), groups: PdfAssetKind[] = []
  const requests: Parameters<PdfBinaryDataFactory['fetch']>[0][] = []
  const Base = createPdfBinaryDataFactory(controller.signal, async (group) => {
    groups.push(group)
    const dir = join(root, directories[group]), names = (await readdir(dir)).filter(name => !name.startsWith('LICENSE')).sort()
    return Object.fromEntries(await Promise.all(names.map(async name => [name, (await readFile(join(dir, name))).toString('base64')] as const)))
  })
  class BinaryDataFactory extends Base {
    override fetch(request: Parameters<PdfBinaryDataFactory['fetch']>[0]): Promise<Uint8Array> {
      requests.push(request)
      return super.fetch(request)
    }
  }
  let bridge: PDFWorker | undefined, loading: ReturnType<typeof getDocument> | undefined
  try {
    await Promise.race([ready.promise, failed.promise])
    bridge = PDFWorker.create({ port: port as unknown as Worker })
    loading = getDocument({
      data: pdfResourceFixture(kind), worker: bridge, BinaryDataFactory,
      useWorkerFetch: false, useSystemFonts: false, stopAtErrors: true,
    })
    const pdf = await Promise.race([loading.promise, failed.promise])
    expect(pdf.numPages).toBe(1)
    const page = await pdf.getPage(1), text = await page.getTextContent()
    if (kind === 'cjk') expect(text.items.filter(item => 'str' in item).map(item => item.str).join('')).toBe('日本語')
    const factory = pdf.canvasFactory as {
      create(width: number, height: number): { canvas: HTMLCanvasElement; context: CanvasRenderingContext2D }
      destroy(value: { canvas: HTMLCanvasElement; context: CanvasRenderingContext2D }): void
    }
    const target = factory.create(1, 1)
    Object.defineProperty(target.canvas, 'style', { value: { setProperty: () => {} } })
    try {
      await renderPdfPage(pdf, 1, target.canvas, controller.signal, 1)
      const pixels = target.context.getImageData(0, 0, target.canvas.width, target.canvas.height).data
      expect(pixels.some((v, index) => index % 4 !== 3 && v < 200)).toBe(true)
      if (kind === 'vector' || kind === 'jpx') {
        const pixel = target.context.getImageData(target.canvas.width / 2, target.canvas.height / 2, 1, 1).data
        expect(pixel[0]! - pixel[2]!).toBeGreaterThan(150)
      }
      if (kind === 'jbig2') {
        const pixel = target.context.getImageData(target.canvas.width / 2, target.canvas.height / 2, 1, 1).data
        expect(pixel[0]).toBeLessThan(50)
      }
    } finally { factory.destroy(target) }
    if (kind === 'vector') expect(requests).toEqual([])
    if (kind === 'standard') expect(requests.map(value => value.kind)).toContain('standardFontDataUrl')
    if (kind === 'cjk') expect(requests.map(value => value.kind)).toContain('cMapUrl')
    if (kind === 'jpx') expect(requests.map(value => value.filename)).toContain('openjpeg.wasm')
    if (kind === 'jbig2') expect(requests.map(value => value.filename)).toContain('jbig2.wasm')
    expect(new Set(groups).size).toBe(groups.length)
  } finally {
    controller.abort()
    try { await loading?.destroy() } finally { bridge?.destroy(); await thread.terminate() }
  }
})
