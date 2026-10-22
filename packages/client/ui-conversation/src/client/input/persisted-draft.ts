/** Decode browser-persisted drafts without carrying machine-local occurrence identities. */
import { z } from 'zod'
import type { DraftReference, DraftSnapshot } from './contract.ts'
import { referenceDraftText } from './machine.ts'

const referenceSchema = z.object({
  source: z.string(),
  ref: z.string(),
  offset: z.number().int().nonnegative(),
  length: z.number().int().positive(),
  label: z.string(),
  appearance: z.enum(['session', 'file', 'folder']).optional(),
  clipboardText: z.string(),
  invalid: z.boolean().optional(),
})

const draftSchema = z.object({
  text: z.string(),
  references: z.array(z.unknown()).catch([]),
  command: z.object({ token: z.string().min(1) }).optional().catch(undefined),
})

/**
 * Read a legacy string or semantic draft from localStorage.
 * Invalid, overlapping, or text-mismatched reference records become plain
 * text; valid text survives malformed metadata. Command callbacks and
 * occurrence ids are never restored from storage.
 * @param value - JSON-parsed persisted draft.
 * @returns usable draft input, or empty text when no text could be recovered.
 */
export function readPersistedDraft(value: unknown): string | DraftSnapshot {
  if (typeof value === 'string') return value
  const parsed = draftSchema.safeParse(value)
  if (!parsed.success) return ''
  const { text, command } = parsed.data
  const references: DraftReference[] = []
  let end = 0
  for (const candidate of parsed.data.references) {
    const parsedReference = referenceSchema.safeParse(candidate)
    if (!parsedReference.success) continue
    const reference = parsedReference.data
    const nextEnd = reference.offset + reference.length
    if (reference.offset < end || nextEnd > text.length
      || text.slice(reference.offset, nextEnd) !== referenceDraftText(reference)) continue
    const { appearance, invalid, ...required } = reference
    references.push({
      ...required,
      ...appearance === undefined ? {} : { appearance },
      ...invalid === undefined ? {} : { invalid },
    })
    end = nextEnd
  }
  const claimed = command !== undefined && text.startsWith(command.token) ? command : undefined
  if (references.length === 0 && claimed === undefined) return text
  return { text, references, ...claimed === undefined ? {} : { command: claimed } }
}
