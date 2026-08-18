/**
 * `@deepseek-ai/dsh-client-ui-documents/client`
 *
 * Workspace document manager: browse, preview, upload, and delete documents
 * uploaded through the conversation input box.
 * @module client
 */

import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
import { DocumentsButton } from './DocumentsButton.tsx'
import { DocumentsModal } from './DocumentsModal.tsx'
import { DocumentPreview } from './DocumentPreview.tsx'
import { NS, en, zh } from './locales.ts'
import type { DocumentsKey } from './locales.ts'

export type { DocumentsKey } from './locales.ts'
export type { DocumentsModalProps } from './DocumentsModal.tsx'
export type { DocumentPreviewProps } from './DocumentPreview.tsx'
export { formatBytes, getDateGroup } from './format.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    documents: DocumentsKey
  }
}

export const inject = ['slots', 'locale']

export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'ui-documents: dictionaries')

  ctx.slots.inject('sidebar.footer.action', () => ctx.slots.register({
    name: 'sidebar.footer.action',
    id: 'documents',
    order: -10,
    locale: NS,
  }, DocumentsButton))
}

export { DocumentsButton, DocumentsModal, DocumentPreview }
