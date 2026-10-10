/** Producer-source and tool-role V6-to-V7 migration with native V7 framing and delivery validation. */

export { releasedV6SessionFormatCodec } from '@deepseek-ai/dsh-session-format-v5-to-v6'
export * from './codec.ts'
export * from './migration.ts'
export { assertReleasedV7Header, assertReleasedV7Relationships, restoreReleasedV7Artifact } from './validation.ts'
export { ADMITTED_V6_EVENT_TYPES, RELEASED_V6_EVENT_TYPES } from './extension-identities.ts'
