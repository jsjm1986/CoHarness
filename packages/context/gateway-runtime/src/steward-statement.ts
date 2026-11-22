/** Statement routing shared by the steward approval tool and Gateway executor. */

const READ_HEADS = new Set(['SELECT', 'VALUES', 'TABLE', 'SHOW', 'EXPLAIN'])
const WRITE_HEADS = new Set(['INSERT', 'UPDATE', 'DELETE', 'MERGE'])
const TOKEN_PATTERN = [
  String.raw`\s+|--[^\r\n]*|/\*`,
  String.raw`\$[\p{L}_][\p{L}\p{N}_]*\$|\$\$`,
  String.raw`E'(?:[^'\\]|\\[\s\S]|'')*'|'(?:[^']|'')*'`,
  String.raw`"(?:[^"]|"")*"|[\p{L}_][\p{L}\p{N}_$]*`,
  '.',
].join('|')

function* tokens(sql: string): Generator<string> {
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
      yield '?'
      continue
    }
    if (match.startsWith("'") || /^e'/i.test(match) || match.startsWith('"')) {
      yield '?'
      continue
    }
    yield match.toUpperCase()
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

function withWrites(parts: readonly string[]): boolean {
  const lists = [0]
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
      pos = afterGroup(parts, pos)
      if (parts[pos] !== ',') {
        if (WRITE_HEADS.has(parts[pos] ?? '')) return true
        break
      }
      pos++
    }
  }
  return false
}

/**
 * Choose the approval lane from the statement's command and its CTE bodies.
 * PostgreSQL still parses and executes the statement under the selected lane's
 * transaction and approval checks.
 * @param sql - one steward statement.
 * @returns the read or write lane.
 */
export function classifyStewardStatement(sql: string): 'read' | 'write' {
  const input = tokens(sql)
  try {
    const first = input.next()
    if (first.done) return 'write'
    if (first.value === 'WITH') return withWrites([...input]) ? 'write' : 'read'
    return READ_HEADS.has(first.value) ? 'read' : 'write'
  } finally {
    input.return(undefined)
  }
}
