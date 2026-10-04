/**
 * Escape PostgreSQL LIKE/ILIKE metacharacters so a user-supplied needle stays
 * literal: backslash, `%`, and `_` are quoted with the default `\` escape.
 * @param value - plain-text fragment to wrap in a containing pattern.
 * @returns a `%value%` pattern matching any row containing `value` verbatim.
 */
export function literalLikePattern(value: string): string {
  return `%${value.replaceAll('\\', '\\\\').replaceAll('%', '\\%').replaceAll('_', '\\_')}%`
}
