/** Stable archive identifiers are separate from Runtime-local Host Session identifiers. @module */
import type { Branded } from '@deepseek-ai/dsh-brand'
import { z } from 'zod'

/** One durable archive lifecycle record, independent of its Host Session identifier. */
export type ConversationArchiveId = Branded<'ConversationArchiveId'>
const archiveIdSchema = z.string().uuid()

/**
 * Parse an administrator archive identifier received over HTTP.
 * @param value - untrusted route or JSON field.
 * @returns its canonical identity, or absence for an invalid identifier.
 */
export function parseConversationArchiveId(value: unknown): ConversationArchiveId | undefined {
  const parsed = archiveIdSchema.safeParse(value)
  return parsed.success ? parsed.data.toLowerCase() as ConversationArchiveId : undefined
}
