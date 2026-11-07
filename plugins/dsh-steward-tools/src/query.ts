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

/**
 * Statement preview for the approval prompt. Approving the wrong statement is
 * the lane's deception surface, so the prompt keeps every line of the
 * statement and truncates only well past what a reviewer can scan.
 */
export function statementPreview(sql: string): string {
  const body = sql.replace(NOISE, '').trim()
  return body.length > 2000 ? `${body.slice(0, 1997)}...` : body
}
