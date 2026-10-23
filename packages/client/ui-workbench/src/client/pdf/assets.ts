/** Same-version PDF.js resources load by kind and decode under the document lifetime. */
import workerSource from 'pdfjs-dist/build/pdf.worker.min.mjs?raw'

export { workerSource }

/** Resource kinds used by PDF.js 6's BinaryDataFactory requests. */
export type PdfAssetKind = 'cMapUrl' | 'standardFontDataUrl' | 'wasmUrl'

/** Original filenames mapped to base64, in the same PDF.js version as the worker. */
export type PdfAssetMap = Readonly<Record<PdfAssetKind, Readonly<Record<string, string>>>>

/** Read one data-only lazy group through the owning Client module loader. */
export type LoadPdfAssets = (kind: PdfAssetKind) => Promise<Readonly<Record<string, string>>>

const loadPdfAssets: LoadPdfAssets = async (kind) => {
  switch (kind) {
    case 'cMapUrl': return (await import('./cmaps.ts')).cMaps
    case 'standardFontDataUrl': return (await import('./fonts.ts')).fonts
    case 'wasmUrl': return (await import('./wasm.ts')).wasm
    default: return assertNever(kind)
  }
}

function assertNever(kind: never): never { throw new Error(`Unknown PDF.js asset kind: ${String(kind)}`) }

/** Public methods required by PDF.js's BinaryDataFactory option. */
export interface PdfBinaryDataFactory {
  /** @param request - PDF.js resource kind and exact filename. @returns independent transferable resource bytes. */
  fetch(request: { readonly kind: PdfAssetKind; readonly filename: string }): Promise<Uint8Array>
}

/**
 * Load only resource groups requested by this document, without external fallbacks.
 * @param signal - document lifetime; closing rejects pending reads before their imports settle.
 * @param load - version-matched resource-group loader; each kind is shared within this document.
 * @returns the constructor passed to PDF.js getDocument.
 */
export function createPdfBinaryDataFactory(signal: AbortSignal, load: LoadPdfAssets = loadPdfAssets): new () => PdfBinaryDataFactory {
  const groups = new Map<PdfAssetKind, ReturnType<LoadPdfAssets>>()
  return class implements PdfBinaryDataFactory {
    async fetch({ kind, filename }: { readonly kind: PdfAssetKind; readonly filename: string }): Promise<Uint8Array> {
      signal.throwIfAborted()
      let pending = groups.get(kind)
      if (pending === undefined) {
        pending = load(kind)
        groups.set(kind, pending)
      }
      const cancelled = Promise.withResolvers<never>()
      const aborted = (): void => { cancelled.reject(signal.reason) }
      try {
        signal.addEventListener('abort', aborted, { once: true })
        const files = await Promise.race([pending, cancelled.promise])
        signal.throwIfAborted()
        const data = Object.hasOwn(files, filename) ? files[filename] : undefined
        if (data === undefined) throw new Error(`PDF.js asset is not bundled: ${kind}/${filename}`)
        return Uint8Array.from(atob(data), character => character.charCodeAt(0))
      } finally {
        signal.removeEventListener('abort', aborted)
      }
    }
  }
}
