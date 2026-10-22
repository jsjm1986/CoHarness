/** Finite HTML-declared classic scripts and stylesheets; no module, CSS dependency or runtime fetch traversal. */
import type { HtmlAsset, HtmlBundle } from '../../html/bootstrap.ts'
import { decodeText } from './bytes.ts'

/**
 * A read bound to the original document's session and directory, using ordinary file operations.
 * @param reference - HTML-decoded relative URL, including any query or fragment; the reader resolves its file path.
 * @param signal - cancellation of this packing operation.
 * @returns complete file bytes; permission and read failures reject.
 */
export type ReadHtmlRelative = (reference: string, signal: AbortSignal) => Promise<Uint8Array<ArrayBuffer>>

/** Per-asset collection bound enforced by the resource reader and the package check. */
export const MAX_ASSET_BYTES = 4 * 1024 * 1024
/** Combined package bound covering the root document and every packed asset. */
export const MAX_TOTAL_BYTES = 32 * 1024 * 1024
const MAX_ASSETS = 64

/** Blob MIME for an image's filename suffix; the suffix selects the type because browsers refuse extensionless SVG. */
const IMAGE_MIME: Record<string, string> = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif',
  webp: 'image/webp', avif: 'image/avif', svg: 'image/svg+xml', ico: 'image/x-icon', bmp: 'image/bmp',
}

/** Whether this reference can be read relative to the original document, never the parent application URL. */
function relative(reference: string): boolean {
  return reference.length > 0 && !/^(?:[a-z][a-z\d+.-]*:|[/\\#?])/iu.test(reference) && !reference.includes('\0')
}

/**
 * Collect static dependencies without executing or mounting document elements in the parent page.
 * A base element leaves URL resolution to the browser. Only direct .js classic scripts, .css
 * stylesheet links, and .png/.jpg/.gif/.webp/.avif/.svg/.ico/.bmp images are packed; srcset,
 * local CSS url/import, modules and dynamically constructed URLs are unsupported.
 * Independent assets read in document-ordered batches sized by the remaining
 * package bytes and the maximum asset size. A failed batch cancels and drains
 * every read it started before rejecting; no partial package is published.
 * @param data - complete UTF-8 HTML bytes.
 * @param readRelative - original-document-scoped read, never exposed to the iframe.
 * @param signal - stops reads and prevents publication after cancellation.
 * @returns complete HTML and its finite static asset set; decoding, limits and read failures reject.
 */
export async function packHtml(
  data: Uint8Array<ArrayBuffer>,
  readRelative: ReadHtmlRelative,
  signal: AbortSignal,
): Promise<HtmlBundle> {
  signal.throwIfAborted()
  let total = data.byteLength
  if (total > MAX_TOTAL_BYTES) throw new Error('HTML package exceeds its total byte limit')
  const template = document.createElement('template')
  template.innerHTML = decodeText(data)
  const assets: HtmlAsset[] = []
  if (template.content.querySelector('base[href]') !== null) return { data, assets }

  const seen = new Set<string>()
  const references: Omit<HtmlAsset, 'data'>[] = []
  for (const element of template.content.querySelectorAll('script[src],link[href],img[src]')) {
    const script = element.localName === 'script'
    const image = element.localName === 'img'
    const type = element.getAttribute('type')?.trim().toLowerCase() ?? ''
    if (script && !['', 'text/javascript', 'application/javascript'].includes(type)) continue
    if (!script && !image && !(element.getAttribute('rel') ?? '').toLowerCase().split(/\s+/u).includes('stylesheet')) continue
    // The selector requires the corresponding URL attribute.
    const reference = element.getAttribute(script || image ? 'src' : 'href') as string
    const suffix = reference.search(/[?#]/u)
    const path = suffix === -1 ? reference : reference.slice(0, suffix)
    let kind: HtmlAsset['kind'], mime: string
    if (image) {
      const extension = /\.([a-z\d]+)$/iu.exec(path)?.[1]?.toLowerCase()
      const imageMime = extension === undefined ? undefined : IMAGE_MIME[extension]
      if (imageMime === undefined) continue
      kind = 'image'; mime = imageMime
    } else {
      if (!(script ? /\.js$/iu : /\.css$/iu).test(path)) continue
      kind = script ? 'script' : 'stylesheet'; mime = script ? 'text/javascript' : 'text/css'
    }
    if (!relative(reference)) continue
    const key = `${kind}:${reference}`
    if (seen.has(key)) continue
    if (references.length >= MAX_ASSETS) throw new Error('HTML package exceeds its asset count limit')
    references.push({ kind, reference, type: mime })
    seen.add(key)
  }
  const abort = new AbortController()
  const readSignal = AbortSignal.any([signal, abort.signal])
  try {
    for (let offset = 0; offset < references.length;) {
      readSignal.throwIfAborted()
      // One asset may still fit when the remaining bytes are below the per-asset maximum.
      const width = Math.max(1, Math.floor((MAX_TOTAL_BYTES - total) / MAX_ASSET_BYTES))
      const batch = references.slice(offset, offset + width)
      const pending = batch.map(async (reference): Promise<HtmlAsset> => {
        try {
          readSignal.throwIfAborted()
          const asset = await readRelative(reference.reference, readSignal)
          readSignal.throwIfAborted()
          if (asset.byteLength > MAX_ASSET_BYTES) throw new Error('HTML asset exceeds its byte limit')
          if (reference.kind !== 'image') decodeText(asset)
          return { ...reference, data: asset }
        } catch (error) {
          abort.abort(error)
          throw error
        }
      })
      let completed: HtmlAsset[]
      try {
        completed = await Promise.all(pending)
      } finally {
        await Promise.allSettled(pending)
      }
      readSignal.throwIfAborted()
      for (const asset of completed) {
        total += asset.data.byteLength
        if (total > MAX_TOTAL_BYTES) throw new Error('HTML package exceeds its total byte limit')
        assets.push(asset)
      }
      offset += batch.length
    }
    readSignal.throwIfAborted()
    return { data, assets }
  } finally {
    abort.abort()
  }
}
