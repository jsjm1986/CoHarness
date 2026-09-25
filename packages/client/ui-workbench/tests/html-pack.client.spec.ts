// @vitest-environment jsdom
/** Static dependency discovery has an injected file reader and never exposes it to the iframe. */
import { describe, expect, it, vi } from 'vitest'
import { packHtml } from '../src/client/html/pack.ts'
import type { ReadHtmlRelative } from '../src/client/html/pack.ts'

const source = '<link rel="stylesheet" href="./main.css"><script src="./main.js"></script>'

const utf8 = (text: string): Uint8Array<ArrayBuffer> => new TextEncoder().encode(text)

describe('packHtml', () => {
  it('collects direct classic JS and CSS in document order and deduplicates repeated references', async () => {
    const read = vi.fn<ReadHtmlRelative>().mockResolvedValue(utf8('/* 你好 */'))
    const signal = new AbortController().signal
    const bundle = await packHtml(utf8(source + '<script defer src="./main.js"></script>'), read, signal)
    expect(read.mock.calls).toEqual([['./main.css', signal], ['./main.js', signal]])
    expect(bundle.assets.map(asset => [asset.kind, asset.reference])).toEqual([['stylesheet', './main.css'], ['script', './main.js']])
    expect(document.querySelector('script,link')).toBeNull()
  })

  it('collects same-directory relative images as binary assets with their MIME type', async () => {
    const png = new Uint8Array([137, 80, 78, 71])
    const read = vi.fn<ReadHtmlRelative>().mockResolvedValue(png)
    const signal = new AbortController().signal
    const html = '<img src="logo.png"><img src="shots/cover.JPEG"><img src="logo.png"><img src="icon.svg?v=2">'
    const bundle = await packHtml(utf8(html), read, signal)
    expect(read.mock.calls).toEqual([['logo.png', signal], ['shots/cover.JPEG', signal], ['icon.svg?v=2', signal]])
    expect(bundle.assets.map(asset => [asset.kind, asset.reference, asset.type])).toEqual([
      ['image', 'logo.png', 'image/png'],
      ['image', 'shots/cover.JPEG', 'image/jpeg'],
      ['image', 'icon.svg?v=2', 'image/svg+xml'],
    ])
    expect(bundle.assets[0]!.data).toBe(png)
  })

  it('leaves remote, data-URI, root-relative and extensionless images to browser rules', async () => {
    const read = vi.fn<ReadHtmlRelative>()
    const html = '<img src="https://example.invalid/a.png"><img src="//example.invalid/a.png"><img src="data:image/png;base64,AA=="><img src="/a.png"><img src="photo"><img src="clip.mp4">'
    expect((await packHtml(utf8(html), read, new AbortController().signal)).assets).toEqual([])
    expect(read).not.toHaveBeenCalled()
  })

  it('accepts image bytes that are not valid UTF-8', async () => {
    const read = vi.fn<ReadHtmlRelative>().mockResolvedValue(new Uint8Array([255, 0, 255]))
    const bundle = await packHtml(utf8('<img src="a.bmp">'), read, new AbortController().signal)
    expect(bundle.assets).toHaveLength(1)
    expect([...bundle.assets[0]!.data]).toEqual([255, 0, 255])
  })

  it('leaves HTTPS, module, file, root-relative, data and runtime dependencies to browser rules', async () => {
    const read = vi.fn<ReadHtmlRelative>()
    const html = '<script src="https://example.invalid/a.js"></script><script src="//example.invalid/a.js"></script><script type="module" src="./module.js"></script><script type="application/ld+json" src="./data.js"></script><script src="file:///a.js"></script><script src="/a.js"></script><script src="data:text/javascript,1"></script><script>fetch("./data.json")</script><link rel="icon" href="./icon.css"><!-- <script src="./comment.js"></script> -->'
    expect((await packHtml(utf8(html), read, new AbortController().signal)).assets).toEqual([])
    expect(read).not.toHaveBeenCalled()
  })

  it('does not turn base-relative browser resources into local file reads', async () => {
    const read = vi.fn<ReadHtmlRelative>()
    for (const base of ['https://example.invalid/assets/', './assets/', 'file:///assets/']) {
      const bundle = await packHtml(utf8(`<base href="${base}">${source}`), read, new AbortController().signal)
      expect(bundle.assets).toEqual([])
    }
    expect(read).not.toHaveBeenCalled()
  })

  it('does not read a link without a stylesheet relationship', async () => {
    const read = vi.fn<ReadHtmlRelative>()
    const bundle = await packHtml(utf8('<link href="./main.css">'), read, new AbortController().signal)
    expect(bundle.assets).toEqual([])
    expect(read).not.toHaveBeenCalled()
  })

  it('passes decoded HTML attributes to the scoped reader without recursing into CSS imports', async () => {
    const read = vi.fn<ReadHtmlRelative>().mockResolvedValue(utf8('@import "./child.css";a{background:url(./image.png)}'))
    const bundle = await packHtml(utf8('<link rel="STYLESHEET" href="main.css?v=1&amp;x=2">'), read, new AbortController().signal)
    expect(read.mock.calls[0]?.[0]).toBe('main.css?v=1&x=2')
    expect(read).toHaveBeenCalledOnce()
    expect(bundle.assets).toHaveLength(1)
  })

  it('accepts the fixed per-asset limit and rejects oversized roots and assets', async () => {
    const mebibyte = 1024 * 1024
    const html = utf8('<script src="a.js"></script>')
    const read = vi.fn<ReadHtmlRelative>().mockResolvedValue(new Uint8Array(4 * mebibyte))
    const signal = new AbortController().signal
    await expect(packHtml(html, read, signal)).resolves.toMatchObject({ data: html })
    await expect(packHtml(new Uint8Array(32 * mebibyte + 1), read, signal)).rejects.toThrow('total byte limit')
    read.mockResolvedValue(new Uint8Array(4 * mebibyte + 1))
    await expect(packHtml(html, read, signal)).rejects.toThrow('asset exceeds')
  })

  it('rejects fixed aggregate and asset-count limits', async () => {
    const mebibyte = 1024 * 1024
    const aggregate = Array.from({ length: 8 }, (_, index) => `<script src="${index}.js"></script>`).join('')
    const read = vi.fn<ReadHtmlRelative>().mockResolvedValue(new Uint8Array(4 * mebibyte))
    await expect(packHtml(utf8(aggregate), read, new AbortController().signal)).rejects.toThrow('total byte limit')

    const count = Array.from({ length: 65 }, (_, index) => `<script src="${index}.js"></script>`).join('')
    read.mockResolvedValue(new Uint8Array())
    await expect(packHtml(utf8(count), read, new AbortController().signal)).rejects.toThrow('asset count limit')
    expect(read).toHaveBeenCalledTimes(8 + 64)
  })

  it('propagates read errors and rejects malformed resource text instead of returning a partial package', async () => {
    const read = vi.fn<ReadHtmlRelative>().mockRejectedValue(new Error('outside workspace'))
    await expect(packHtml(utf8(source), read, new AbortController().signal)).rejects.toThrow('outside workspace')
    read.mockResolvedValue(new Uint8Array([255]))
    await expect(packHtml(utf8(source), read, new AbortController().signal)).rejects.toThrow()
  })

  it('does not read after abort and discards a read that settles after cancellation', async () => {
    const pending = Promise.withResolvers<Uint8Array<ArrayBuffer>>()
    const read = vi.fn<ReadHtmlRelative>().mockReturnValue(pending.promise)
    const controller = new AbortController()
    const packing = packHtml(utf8(source), read, controller.signal)
    expect(read).toHaveBeenCalledOnce()
    const rejected = expect(packing).rejects.toMatchObject({ name: 'AbortError' })
    controller.abort()
    pending.resolve(utf8('body{}'))
    await rejected
    await expect(packHtml(utf8(source), read, controller.signal)).rejects.toMatchObject({ name: 'AbortError' })
    expect(read).toHaveBeenCalledOnce()
  })
})
