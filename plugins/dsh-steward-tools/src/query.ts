/** Statement classification shared with the Gateway steward endpoint. */
import { classifyStewardStatement } from '@deepseek-ai/dsh-gateway-runtime/steward-statement'

const NOISE = /^\s*(?:--[^\n]*(?:\n|$)|\/\*[\s\S]*?\*\/|\s)*/

/**
 * Whether the tool can submit a statement without an approval interaction.
 * @param sql - model-supplied statement text.
 * @returns true for the read lane.
 */
export function isReadOnly(sql: string): boolean {
  return classifyStewardStatement(sql) === 'read'
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
