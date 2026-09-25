/** Browser entry for the Cordis multi-session Workspace workbench. */
export { apply, inject } from './apply.ts'
export type {
  AddPaneResult, ConversationViewport, ConversationViewportMode, ConversationViewportSnapshot,
} from '@deepseek-ai/dsh-client-runtime/client'
export type { WorkbenchKey } from './locales.ts'
export type { WorkbenchCatalog, WorkbenchConversation } from './catalog.ts'


declare module '@deepseek-ai/dsh-client-ui-sidebar-right/client' {
  interface SidebarRightResourceParamsMap {
    /** Text line navigation for the existing authorized file resource. */
    file: { readonly line?: number }
  }
}
