/** Resource groups load on demand; document cancellation discards their late bytes. */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createPdfBinaryDataFactory, type LoadPdfAssets, type PdfAssetMap } from '../src/client/pdf/assets.ts'

afterEach(() => { vi.unstubAllGlobals() })

const assets: PdfAssetMap = {
  cMapUrl: { 'sample.bcmap': 'AQID' },
  standardFontDataUrl: { 'font.pfb': 'BAU=' },
  wasmUrl: { 'decoder.wasm': 'BgcI' },
}

describe('PDF binary assets', () => {
  it('resolves each real data-module export only after its resource kind is requested', async () => {
    vi.stubGlobal('__DSH_PDFJS_CMAPS__', assets.cMapUrl)
    vi.stubGlobal('__DSH_PDFJS_FONTS__', assets.standardFontDataUrl)
    vi.stubGlobal('__DSH_PDFJS_WASM__', assets.wasmUrl)
    const Factory = createPdfBinaryDataFactory(new AbortController().signal), factory = new Factory()
    expect(Array.from(await factory.fetch({ kind: 'cMapUrl', filename: 'sample.bcmap' }))).toEqual([1, 2, 3])
    expect(Array.from(await factory.fetch({ kind: 'standardFontDataUrl', filename: 'font.pfb' }))).toEqual([4, 5])
    expect(Array.from(await factory.fetch({ kind: 'wasmUrl', filename: 'decoder.wasm' }))).toEqual([6, 7, 8])
  })

  it('loads no group at factory creation and only the group each request needs', async () => {
    const load = vi.fn<LoadPdfAssets>(async kind => assets[kind])
    const Factory = createPdfBinaryDataFactory(new AbortController().signal, load)
    const factory = new Factory()
    expect(load).not.toHaveBeenCalled()
    expect(Array.from(await factory.fetch({ kind: 'cMapUrl', filename: 'sample.bcmap' }))).toEqual([1, 2, 3])
    expect(load.mock.calls).toEqual([['cMapUrl']])
    expect(Array.from(await factory.fetch({ kind: 'standardFontDataUrl', filename: 'font.pfb' }))).toEqual([4, 5])
    expect(Array.from(await factory.fetch({ kind: 'wasmUrl', filename: 'decoder.wasm' }))).toEqual([6, 7, 8])
    expect(load.mock.calls).toEqual([['cMapUrl'], ['standardFontDataUrl'], ['wasmUrl']])
  })

  it('shares a pending group and returns fresh transferable buffers on every read', async () => {
    const pending = Promise.withResolvers<Readonly<Record<string, string>>>()
    const load = vi.fn<LoadPdfAssets>(() => pending.promise)
    const Factory = createPdfBinaryDataFactory(new AbortController().signal, load), factory = new Factory()
    const first = factory.fetch({ kind: 'cMapUrl', filename: 'sample.bcmap' })
    const second = factory.fetch({ kind: 'cMapUrl', filename: 'sample.bcmap' })
    expect(load).toHaveBeenCalledTimes(1)
    pending.resolve(assets.cMapUrl)
    const bytes = await first
    structuredClone(bytes, { transfer: [bytes.buffer] })
    expect(bytes.byteLength).toBe(0)
    expect(Array.from(await second)).toEqual([1, 2, 3])
    expect(Array.from(await factory.fetch({ kind: 'cMapUrl', filename: 'sample.bcmap' }))).toEqual([1, 2, 3])
    expect(load).toHaveBeenCalledTimes(1)
  })

  it.each(['../font.pfb', 'missing.bcmap', 'toString'])('rejects unbundled filename %s without an external fallback', async (filename) => {
    const fetch = vi.fn()
    vi.stubGlobal('fetch', fetch)
    const Factory = createPdfBinaryDataFactory(new AbortController().signal, async kind => assets[kind])
    await expect(new Factory().fetch({ kind: 'cMapUrl', filename })).rejects.toThrow('not bundled')
    expect(fetch).not.toHaveBeenCalled()
  })

  it('rejects a failed group and lets a new document retry the module', async () => {
    const failure = new Error('resource chunk unavailable')
    const load = vi.fn<LoadPdfAssets>().mockRejectedValueOnce(failure).mockResolvedValue(assets.cMapUrl)
    const First = createPdfBinaryDataFactory(new AbortController().signal, load)
    await expect(new First().fetch({ kind: 'cMapUrl', filename: 'sample.bcmap' })).rejects.toBe(failure)
    const Next = createPdfBinaryDataFactory(new AbortController().signal, load)
    expect(Array.from(await new Next().fetch({ kind: 'cMapUrl', filename: 'sample.bcmap' }))).toEqual([1, 2, 3])
    expect(load).toHaveBeenCalledTimes(2)
  })

  it('starts no group for a closed document', async () => {
    const controller = new AbortController(), load = vi.fn<LoadPdfAssets>()
    const Factory = createPdfBinaryDataFactory(controller.signal, load)
    controller.abort()
    await expect(new Factory().fetch({ kind: 'cMapUrl', filename: 'sample.bcmap' })).rejects.toMatchObject({ name: 'AbortError' })
    expect(load).not.toHaveBeenCalled()
  })

  it.each(['resolve', 'reject'] as const)('rejects on close before a pending import can %s', async (outcome) => {
    const controller = new AbortController(), pending = Promise.withResolvers<Readonly<Record<string, string>>>()
    const Factory = createPdfBinaryDataFactory(controller.signal, () => pending.promise)
    const read = new Factory().fetch({ kind: 'cMapUrl', filename: 'sample.bcmap' })
    const settled = expect(read).rejects.toMatchObject({ name: 'AbortError' })
    controller.abort()
    await settled
    if (outcome === 'resolve') pending.resolve(assets.cMapUrl)
    else pending.reject(new Error('late import failure'))
    await Promise.allSettled([pending.promise])
  })
})
