/** ACP adapters share the Session corpus comparison and path rules. */
import {
  normalizeSessionSnapshots,
  scrubSystemPrompts as scrubDurableSystemPrompts,
  scrubModelRequestBulk,
  scrubSessionSnapshot as scrubDurableSessionSnapshot,
  type NormalizeContext,
  type NormalizeOptions,
} from '@deepseek-ai/dsh-session-snapshot'

export {
  extractSnapshotSpillPaths,
  normalizeSessionLog,
  normalizeSessionSnapshots,
  normalizeStdout,
  scrubToolSchemas,
  tokenizeSessionFixtureCwd,
  type CwdPathMode,
  type NormalizeContext,
  type NormalizeOptions,
} from '@deepseek-ai/dsh-session-snapshot'

/**
 * Compare one Session after production migration; multi-session callers use the shared batch API.
 * @param rawLog - persisted or projected Session JSONL.
 * @param ctx - generated paths and issued Session identities.
 * @param options - path spelling controls.
 * @returns normalized current semantics with the physical version compared separately by the suite.
 */
export function normalizeSessionSnapshot(
  rawLog: string,
  ctx: NormalizeContext,
  options: NormalizeOptions = {},
): string {
  return normalizeSessionSnapshots([rawLog], ctx, options)[0]!
}

/**
 * Tokenize legacy header prompts and durable system messages after their independent sidecar comparison.
 * @param rawLog - legacy adapter Session records.
 * @returns nonempty prompts tokenized without erasing an empty or missing prompt.
 */
export function scrubSystemPrompts(rawLog: string): string {
  return scrubDurableSystemPrompts(rawLog).split('\n').map((line) => {
    if (line.trim() === '') return line
    const record = JSON.parse(line) as { type?: unknown; data?: { header?: { system?: unknown } } }
    if (record.type !== 'request/header') return line
    const header = record.data?.header
    if (typeof header?.system !== 'string' || header.system.length === 0) return line
    header.system = '{{system}}'
    return JSON.stringify(record)
  }).join('\n')
}

/**
 * Tokenize independently pinned prompts and schemas in the legacy adapter.
 * @param rawLog - legacy adapter Session records.
 * @returns header bulk replaced by tokens while preserving field presence.
 */
export function scrubRequestHeaders(rawLog: string): string {
  return scrubModelRequestBulk(scrubSystemPrompts(rawLog))
}

/**
 * Project envelopes after tokenizing the legacy adapter's independently pinned headers.
 * @param rawLog - persisted or projected Session records.
 * @returns projected records without duplicated prompt or schema bulk.
 */
export function scrubSessionSnapshot(rawLog: string): string {
  return scrubDurableSessionSnapshot(scrubRequestHeaders(rawLog))
}
