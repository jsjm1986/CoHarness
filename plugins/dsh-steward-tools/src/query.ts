/** Statement classification shared with the Gateway steward endpoint. */

const NOISE = /^\s*(?:--[^\n]*(?:\n|$)|\/\*[\s\S]*?\*\/|\s)*/
const READONLY_HEAD = /^(select|with|values|table|show|explain)\b/i

/**
 * Whether a statement is read-only by its leading keyword. The classifier is
 * optimistic for tooling UX (approval prompts) only — the Gateway reclassifies
 * authoritatively before executing, so a mismatch denies, never silently widens.
 * @param sql - model-supplied statement text.
 * @returns `true` for SELECT-family heads.
 */
export function isReadOnly(sql: string): boolean {
  return READONLY_HEAD.test(sql.replace(NOISE, ''))
}

/** One line of statement preview for the approval prompt. */
export function statementPreview(sql: string): string {
  const head = sql.replace(NOISE, '').split('\n', 1)[0]?.trim() ?? ''
  return head.length > 160 ? `${head.slice(0, 157)}...` : head
}
