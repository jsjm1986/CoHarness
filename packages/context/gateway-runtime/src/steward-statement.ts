/** Statement routing and identifier inspection shared by the steward tool and Gateway executor. */

const READ_HEADS = new Set(['SELECT', 'VALUES', 'TABLE', 'SHOW'])
const WRITE_HEADS = new Set(['INSERT', 'UPDATE', 'DELETE', 'MERGE'])
const EXPLAIN_FALSE_VALUES: ReadonlySet<string | undefined> = new Set(['FALSE', 'OFF', '0'])
const TOKEN_PATTERN = [
  String.raw`\s+|--[^\r\n]*|/\*`,
  String.raw`\$[\p{L}_][\p{L}\p{N}_]*\$|\$\$`,
  String.raw`E'(?:[^'\\]|\\[\s\S]|'')*'|'(?:[^']|'')*'`,
  String.raw`U&"(?:[^"]|"")*"|"(?:[^"]|"")*"`,
  String.raw`[\p{L}_][\p{L}\p{N}_$]*`,
  '.',
].join('|')

type SqlToken =
  | { readonly kind: 'word'; readonly value: string }
  | { readonly kind: 'quoted'; readonly value: string }
  | { readonly kind: 'unicode-quoted' }
  | { readonly kind: 'literal' }
  | { readonly kind: 'symbol'; readonly value: string }

function* lex(sql: string): Generator<SqlToken> {
  const lexeme = new RegExp(TOKEN_PATTERN, 'suiy')
  for (let token = lexeme.exec(sql); token !== null; token = lexeme.exec(sql)) {
    const match = token[0]
    if (/^\s/u.test(match) || match.startsWith('--')) continue
    if (match === '/*') {
      let offset = lexeme.lastIndex
      let depth = 1
      while (depth > 0 && offset < sql.length) {
        if (sql.startsWith('/*', offset)) {
          depth++
          offset += 2
        } else if (sql.startsWith('*/', offset)) {
          depth--
          offset += 2
        } else offset++
      }
      lexeme.lastIndex = offset
      continue
    }
    if (match.startsWith('$') && match.endsWith('$') && match.length >= 2) {
      const close = sql.indexOf(match, lexeme.lastIndex)
      lexeme.lastIndex = close === -1 ? sql.length : close + match.length
      yield { kind: 'literal' }
      continue
    }
    if (match.startsWith("'") || /^e'/i.test(match)) {
      yield { kind: 'literal' }
      continue
    }
    if (/^u&"/i.test(match)) {
      yield { kind: 'unicode-quoted' }
      continue
    }
    if (match.startsWith('"')) {
      yield { kind: 'quoted', value: match.slice(1, -1).replaceAll('""', '"') }
      continue
    }
    if (/^[\p{L}_]/u.test(match)) {
      yield { kind: 'word', value: match.toUpperCase() }
      continue
    }
    yield { kind: 'symbol', value: match }
  }
}

function afterGroup(parts: readonly string[], start: number): number {
  let depth = 1
  for (let pos = start + 1; pos < parts.length; pos++) {
    if (parts[pos] === '(') depth++
    else if (parts[pos] === ')') {
      depth--
      if (depth === 0) return pos + 1
    }
  }
  return parts.length
}

function skipCteClauses(parts: readonly string[], start: number): number {
  let pos = start
  if (parts[pos] === 'SEARCH') {
    while (pos < parts.length && parts[pos] !== 'SET') pos++
    pos += 2
  }
  if (parts[pos] === 'CYCLE') {
    while (pos < parts.length && parts[pos] !== 'USING') pos++
    pos += 2
  }
  return pos
}

function withWrites(parts: readonly string[], initialStart = 0): boolean {
  const lists = [initialStart]
  for (const start of lists) {
    let pos = parts[start] === 'RECURSIVE' ? start + 1 : start
    while (pos < parts.length) {
      pos++ // CTE name
      if (parts[pos] === '(') pos = afterGroup(parts, pos)
      if (parts[pos++] !== 'AS') break
      if (parts[pos] === 'NOT') pos++
      if (parts[pos] === 'MATERIALIZED') pos++
      if (parts[pos] !== '(') break

      let body = pos + 1
      while (parts[body] === '(') body++
      const operation = parts[body] ?? ''
      if (WRITE_HEADS.has(operation)) return true
      if (operation === 'WITH') lists.push(body + 1)
      pos = skipCteClauses(parts, afterGroup(parts, pos))
      if (parts[pos] !== ',') {
        if (WRITE_HEADS.has(parts[pos] ?? '')) return true
        break
      }
      pos++
    }
  }
  return false
}

function classifyExplain(parts: readonly string[], start: number): 'read' | 'write' {
  let pos = start
  let analyzes = false
  if (parts[pos] === '(') {
    const end = afterGroup(parts, pos)
    for (let index = pos + 1; index < end - 1; index++) {
      const option = parts[index]
      if (option !== 'ANALYZE' && option !== 'ANALYSE') continue
      const next = parts[index + 1]
      analyzes = next === ')' || next === ',' || !EXPLAIN_FALSE_VALUES.has(next)
    }
    pos = end
  } else {
    while (pos < parts.length) {
      const option = parts[pos]
      if (option === 'ANALYZE' || option === 'ANALYSE') {
        analyzes = true
        pos++
      } else if (option === 'VERBOSE') {
        pos++
      } else break
    }
  }
  if (!analyzes) return 'read'
  return classifyTokens(parts, pos)
}

function classifyTokens(parts: readonly string[], start: number): 'read' | 'write' {
  const first = parts[start]
  if (first === undefined) return 'write'
  if (first === 'WITH') return withWrites(parts, start + 1) ? 'write' : 'read'
  if (first === 'EXPLAIN') return classifyExplain(parts, start + 1)
  return READ_HEADS.has(first) ? 'read' : 'write'
}

/**
 * Choose the approval lane from the statement's command, CTE bodies, and
 * executing `EXPLAIN ANALYZE` forms. PostgreSQL still parses and executes the
 * statement under the selected lane's transaction and approval checks.
 * @param sql - one steward statement.
 * @returns the read or write lane.
 */
export function classifyStewardStatement(sql: string): 'read' | 'write' {
  const parts: string[] = []
  for (const token of lex(sql)) {
    parts.push(token.kind === 'word' || token.kind === 'symbol' ? token.value : '?')
  }
  return classifyTokens(parts, 0)
}

/**
 * Report whether a read-lane statement references any denied SQL identifier
 * outside comments and string literals, or uses a Unicode-escaped identifier
 * (`U&"..."`) whose decoded name could evade static screening.
 * @param sql - one steward statement.
 * @param denied - lowercase SQL identifier names forbidden on the read lane.
 * @returns true when the statement must be refused on the read lane.
 */
export function hasStewardReadDeniedIdentifier(sql: string, denied: ReadonlySet<string>): boolean {
  for (const token of lex(sql)) {
    if (token.kind === 'unicode-quoted') return true
    if ((token.kind === 'word' || token.kind === 'quoted') && denied.has(token.value.toLowerCase())) {
      return true
    }
  }
  return false
}
