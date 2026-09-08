/** Browser entry for the Cordis multi-session Workspace workbench. */
export { apply, inject } from './apply.ts'
export type {
  AddPaneResult, ConversationViewport, ConversationViewportMode, ConversationViewportSnapshot,
} from '@deepseek-ai/dsh-client-runtime/client'
export type { WorkbenchKey } from './locales.ts'
export type { WorkbenchCatalog, WorkbenchConversation } from './catalog.ts'
export { readWorkbenchRegistry, writeWorkbenchRegistry } from './registry.ts'
export type { WorkbenchLayout, WorkbenchRegistrySnapshot } from './registry.ts'
