/**
 * Narrow `@deepseek-ai/dsh-client-runtime/client` substitute for the compiled
 * fold worker. The package's `/client` entry is a module-table factory that
 * plain Node cannot import, so the worker aliases the specifier here and the
 * leaf modules join the bundle like the conversation-node sources.
 */

export { IncrementalAssistantBlocks } from '../../packages/client/runtime/src/client/sessions/partial.ts'
export { contextForm, contextProducer, sessionRecallLabels } from '../../packages/client/runtime/src/client/sessions/context-producer.ts'
export { displayFailureMessage } from '../../packages/client/runtime/src/client/sessions/failure-display.ts'
export { isTokenDelta } from '../../packages/client/runtime/src/client/sessions/assistant-timing.ts'
export { sanitizeAssistantText, toAssistantBlocks } from '../../packages/client/runtime/src/client/sessions/conversation.ts'
export { isAppendSurfaceEvent, isReplacementSurfaceEvent } from '@deepseek-ai/dsh-session/surface'
