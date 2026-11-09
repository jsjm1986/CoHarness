/** Reject an ambiguous origin label in maintained prose while preserving recorded audit identifiers. */

import { execFileSync } from 'node:child_process'
import { lstatSync, readFileSync, readlinkSync } from 'node:fs'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import ts from 'typescript'

const root = resolve(import.meta.dirname, '..')
const blockedTerm = 'prove' + 'nance'
const excludedPrefixes = ['vendor/', '.agents/notes/archived/'] as const

/** One blocked term occurrence in a tracked path or text line. */
export interface ConcreteTermViolation {
  /** Repository-relative tracked path. */
  file: string
  /** One-based source line, or null when the path contains the term. */
  line: number | null
}

function isExcluded(file: string): boolean {
  return excludedPrefixes.some(prefix => file.startsWith(prefix))
    // Release snapshots retain the identifiers present in their pinned source;
    // historical-format pairing records key sections by those identifiers' headings.
    || /^docs\/persistence-changes\/releases\/dsh-v\d+\.\d+\.\d+-(?:alpha|rc)\.\d+\.schema\.json$/u.test(file)
    || /^docs\/persistence-changes\/historical-formats\/v(?:0|[1-9]\d*)\.(?:schema\.json|i18n\.yaml)$/u.test(file)
    // Alignment inventories record verbatim upstream commit subjects and file paths.
    || /^upgrades\/alignment\/UPSTREAM-[^/]+\.json$/u.test(file)
}

function containsBlockedTerm(value: string): boolean {
  return value.normalize('NFKC').toLowerCase().includes(blockedTerm)
}

function auditFields(node: ts.ObjectLiteralExpression): Map<string, ts.PropertyAssignment> {
  const fields = new Map<string, ts.PropertyAssignment>()
  for (const property of node.properties) {
    if (ts.isPropertyAssignment(property) && ts.isStringLiteral(property.name)) fields.set(property.name.text, property)
  }
  return fields
}

function recordedCommand(fields: ReadonlyMap<string, ts.PropertyAssignment>): boolean {
  const command = fields.get('command')?.initializer, exit = fields.get('exitCode')?.initializer
  const cwd = fields.get('cwd')?.initializer, started = fields.get('startedAt')?.initializer
  const first = command !== undefined && ts.isArrayLiteralExpression(command) ? command.elements[0] : undefined
  return command !== undefined && (ts.isStringLiteral(command) && command.text.trim() !== ''
    || ts.isArrayLiteralExpression(command) && first !== undefined && ts.isStringLiteral(first)
      && first.text.trim() !== '' && command.elements.every(ts.isStringLiteral))
    && exit !== undefined && ts.isNumericLiteral(exit) && Number.isSafeInteger(Number(exit.text)) && Number(exit.text) >= 0
    && cwd !== undefined && ts.isStringLiteral(cwd) && cwd.text.trim() !== '' && !/[\r\n\0]/u.test(cwd.text)
    && started !== undefined && ts.isStringLiteral(started) && Number.isFinite(Date.parse(started.text))
}

function auditArtifactReference(value: string): boolean {
  return !/[\r\n\0]/u.test(value) && /\.(?:json|jsonl|log|md|mjs|py|txt)$/u.test(value)
    && (/^[a-zA-Z0-9_.-]+$/u.test(value) || /^(?:\/|[a-zA-Z]:[\\/]|\.\.?\/)/u.test(value)
      || !/\s/u.test(value) && /[\\/]/u.test(value))
}

/** Preserve recorded command bytes and artifact identifiers while retaining line positions for authored audit prose. */
function withoutRecordedAuditText(file: string, source: string): string {
  if (!/^\.agents\/audits\/.+\.json$/u.test(file) || !containsBlockedTerm(source)) return source
  try { JSON.parse(source) }
  catch (error) {
    if (error instanceof SyntaxError) return source
    throw error
  }
  const parsed = ts.parseJsonText(file, source), ranges: Array<readonly [number, number]> = []
  const keep = (node: ts.Node): void => { ranges.push([node.getStart(parsed), node.end]) }
  const visit = (node: ts.Node, parent?: ts.Node): void => {
    if (ts.isStringLiteral(node) && auditArtifactReference(node.text)) keep(node)
    if (ts.isObjectLiteralExpression(node)) {
      const fields = auditFields(node)
      if (recordedCommand(fields)) {
        for (const key of ['command', 'cwd', 'outputTail', 'stdout', 'stderr', 'stdoutTail', 'stderrTail']) {
          const field = fields.get(key)
          if (field !== undefined && (key === 'command' || ts.isStringLiteral(field.initializer))) keep(field.initializer)
        }
        if (parent !== undefined && ts.isPropertyAssignment(parent) && ts.isStringLiteral(parent.name)
          && /^[a-z0-9]+(?:-[a-z0-9]+)+$/u.test(parent.name.text)) keep(parent.name)
      }
      const name = fields.get('name')?.initializer, receipt = fields.get('receipt')?.initializer
      if (name !== undefined && ts.isStringLiteral(name) && receipt !== undefined && ts.isStringLiteral(receipt)
        && auditArtifactReference(receipt.text) && receipt.text.split(/[\\/]/u).at(-1) === `${name.text}.json`) keep(name)
    }
    ts.forEachChild(node, (child) => { visit(child, node) })
  }
  visit(parsed)
  const pieces: string[] = []
  let end = 0
  for (const [start, next] of ranges.sort((a, b) => a[0] - b[0] || b[1] - a[1])) {
    if (next <= end) continue
    pieces.push(source.slice(end, Math.max(end, start)), source.slice(Math.max(end, start), next).replace(/[^\r\n]/gu, ' '))
    end = next
  }
  pieces.push(source.slice(end))
  return pieces.join('')
}

function historicalSchemaRegion(file: string, source: string, lines: readonly string[]): readonly [number, number] | undefined {
  if (!/^docs\/persistence-changes\/historical-formats\/v(?:0|[1-9]\d*)(?:\.zh)?\.md$/u.test(file)) return undefined
  if (source.match(/<!--\s*persistence-format-schema\b/giu)?.length !== 2) return undefined
  const start = lines.indexOf('<!-- persistence-format-schema:start -->')
  const end = lines.indexOf('<!-- persistence-format-schema:end -->')
  // The format gate checks these generated lines against their historical schema inventory.
  return start >= 0 && end > start ? [start, end] : undefined
}

/**
 * Find the blocked term in one maintained tracked file.
 * @param file - repository-relative tracked path.
 * @param source - text contents or symlink target.
 * @returns violations outside frozen sources, checked historical regions and recorded audit command or artifact identifiers.
 */
export function findConcreteTermViolations(file: string, source: string): ConcreteTermViolation[] {
  if (isExcluded(file)) return []
  const violations: ConcreteTermViolation[] = []
  if (containsBlockedTerm(file)) violations.push({ file, line: null })
  const lines = withoutRecordedAuditText(file, source).split(/\r?\n/u)
  const schemaRegion = historicalSchemaRegion(file, source, lines)
  for (const [index, line] of lines.entries()) {
    if (schemaRegion !== undefined && index > schemaRegion[0] && index < schemaRegion[1]) continue
    if (containsBlockedTerm(line)) violations.push({ file, line: index + 1 })
  }
  return violations
}

function trackedFiles(repoRoot: string): string[] {
  const files = execFileSync('git', ['ls-files', '-z'], {
    cwd: repoRoot, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024,
  })
    .split('\0')
    .filter(file => file !== '')
  if (!files.includes('AGENTS.md')
    || !files.some(file => file.startsWith('packages/'))
    || !files.some(file => file.startsWith('docs/'))
    || !files.some(file => file.startsWith('vendor/'))
    || !files.some(file => file.startsWith('.agents/notes/archived/'))) {
    throw new Error('verify-concrete-terms: tracked-file discovery omitted a required repository area')
  }
  return files
}

/**
 * Read one tracked file without following a symlink to its target.
 * @param repoRoot - Repository root containing the tracked path.
 * @param file - Repository-relative tracked path.
 * @returns File text, the symlink target, or undefined when the path is absent or not a file.
 */
export function readTrackedSource(repoRoot: string, file: string): string | undefined {
  const path = resolve(repoRoot, file)
  const stat = lstatSync(path, { throwIfNoEntry: false })
  if (stat === undefined) return undefined
  if (stat.isSymbolicLink()) return readlinkSync(path)
  return stat.isFile() ? readFileSync(path, 'utf8') : undefined
}

function scanRepository(repoRoot: string): ConcreteTermViolation[] {
  const violations: ConcreteTermViolation[] = []
  for (const file of trackedFiles(repoRoot)) {
    const source = readTrackedSource(repoRoot, file)
    if (source === undefined) continue
    violations.push(...findConcreteTermViolations(file, source))
  }
  return violations
}

const invokedPath = process.argv[1]
const isMain = invokedPath !== undefined && import.meta.url === pathToFileURL(resolve(invokedPath)).href
if (isMain) {
  const violations = scanRepository(root)
  if (violations.length === 0) {
    console.log(`verify-concrete-terms: maintained prose contains no ${blockedTerm}; recorded audit identifiers are preserved.`)
  } else {
    console.error(`verify-concrete-terms: ${blockedTerm} is forbidden; name the exact source, field, identity, or evidence:`)
    for (const violation of violations) {
      console.error(violation.line === null
        ? `  ${violation.file} (path)`
        : `  ${violation.file}:${String(violation.line)}`)
    }
    process.exitCode = 1
  }
}
