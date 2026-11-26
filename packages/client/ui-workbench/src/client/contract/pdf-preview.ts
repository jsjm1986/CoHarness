/** Serializable input for an independently mounted, authenticated PDF reader. */
import type {} from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '../pdf/locales.ts'

/** The caller supplies the authorized address and its current content identity. */
export interface PdfPreviewInput {
  /** Same-origin content URL pinned to the caller's account and Runtime. */
  readonly sourceUrl: string
  /** Scope, document and revision identity; changes reset page and zoom preferences. */
  readonly documentKey: string
  /** Complete-body byte budget; zero displays unsupported content without requesting it. */
  readonly maxBytes: number
}

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface SlotFactoryMap {
    /** PDF reading with a caller-authorized URL and reader-owned network/rendering lifetime. */
    'document.pdf.preview': {
      scope: 'root'
      props: PdfPreviewInput
      locale: 'sidebarPdf'
    }
  }
}
