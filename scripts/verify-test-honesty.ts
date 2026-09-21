/** Reject unexplained coverage suppression and unconditional test disabling. */
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { parseArgs } from 'node:util'
import ts from 'typescript'

/** One source-owned verification defect. */
export interface TestHonestyIssue {
  readonly path: string
  readonly line: number
  readonly rule: 'coverage-ignore' | 'test-skip'
  readonly message: string
}

interface Comment {
  pos: number
  end: number
  body: string
}

function commentsIn(file: ts.SourceFile): Comment[] {
  const ranges = new Map<number, ts.CommentRange>()
  const visit = (node: ts.Node): void => {
    for (const range of [
      ...ts.getLeadingCommentRanges(file.text, node.getFullStart()) ?? [],
      ...ts.getTrailingCommentRanges(file.text, node.end) ?? [],
    ]) ranges.set(range.pos, range)
    ts.forEachChild(node, visit)
  }
  visit(file)
  return [...ranges.values()].sort((a, b) => a.pos - b.pos).map(range => ({
    pos: range.pos, end: range.end,
    body: file.text.slice(range.pos + 2, range.end - (range.kind === ts.SyntaxKind.MultiLineCommentTrivia ? 2 : 0))
      .replace(/^\s*\* ?/gm, '').trim(),
  }))
}

function hasReason(value: string): boolean {
  return /[\p{L}\p{N}]/u.test(value.replace(/@preserve/g, ''))
}

function precedingComments(comments: readonly Comment[], text: string, position: number): string {
  const result: string[] = []
  for (let index = comments.length - 1; index >= 0; index--) {
    const comment = comments[index]
    if (comment === undefined || comment.end > position) continue
    if (text.slice(comment.end, position).trim() !== '') break
    result.unshift(comment.body)
    position = comment.pos
  }
  return result.join('\n')
}

/**
 * Inspect real syntax; directives embedded in strings are not suppressions.
 * @param path - repository-relative source path.
 * @param source - current source text.
 * @returns violations with stable source locations.
 */
export function inspectTestHonesty(path: string, source: string): TestHonestyIssue[] {
  const file = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true,
    path.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS)
  const comments = commentsIn(file)
  const issues: TestHonestyIssue[] = []
  const report = (position: number, rule: TestHonestyIssue['rule'], message: string): void => {
    issues.push({ path, line: file.getLineAndCharacterOfPosition(position).line + 1, rule, message })
  }
  for (const comment of comments) {
    const directive = /^(?:@preserve\s+)?v8\s+ignore\s+(next(?:\s+\d+)?|start|stop|if|else|file)\b([\s\S]*)$/.exec(comment.body)
    if (directive === null || directive[1] === 'stop') continue
    const previous = precedingComments(comments.filter(item => item.pos !== comment.pos), source, comment.pos)
    if (!hasReason(directive[2] ?? '') && (!hasReason(previous) || /^v8\s+ignore\b/.test(previous))) {
      report(comment.pos, 'coverage-ignore', 'coverage ignore needs an inline or immediately preceding reason')
    }
  }
  if (!/\.(?:spec|e2e|snapshot)\.[cm]?[jt]sx?$/.test(path)) return issues
  const testNames = new Set(['describe', 'it', 'test'])
  const namespaces = new Set<string>()
  for (const statement of file.statements) {
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)
      || statement.moduleSpecifier.text !== 'vitest') continue
    const bindings = statement.importClause?.namedBindings
    if (bindings !== undefined && ts.isNamespaceImport(bindings)) namespaces.add(bindings.name.text)
    if (bindings !== undefined && ts.isNamedImports(bindings)) {
      for (const binding of bindings.elements) {
        if (testNames.has(binding.propertyName?.text ?? binding.name.text)) testNames.add(binding.name.text)
      }
    }
  }
  const testRoot = (node: ts.Expression): boolean => {
    if (ts.isIdentifier(node)) return testNames.has(node.text)
    if (ts.isCallExpression(node)) return testRoot(node.expression)
    if (ts.isPropertyAccessExpression(node)) {
      return (ts.isIdentifier(node.expression) && namespaces.has(node.expression.text) && testNames.has(node.name.text))
        || testRoot(node.expression)
    }
    if (ts.isElementAccessExpression(node)) return testRoot(node.expression)
    return false
  }
  const visit = (node: ts.Node): void => {
    const skip = (ts.isPropertyAccessExpression(node) && node.name.text === 'skip')
      || (ts.isElementAccessExpression(node) && ts.isStringLiteral(node.argumentExpression) && node.argumentExpression.text === 'skip')
    if (skip && (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) && testRoot(node.expression)) {
      let ancestor = node.parent
      let conditional = false
      while (!ts.isSourceFile(ancestor) && !ts.isStatement(ancestor)) {
        if (ts.isConditionalExpression(ancestor)) conditional = true
        ancestor = ancestor.parent
      }
      const reason = precedingComments(comments, source, node.getStart(file))
      if (!conditional && !/test-skip:\s*\S[\s\S]*(?:https?:\/\/|\.md(?:#|\b))/.test(reason)) {
        report(node.getStart(file), 'test-skip', 'unconditional skip needs test-skip: reason and a decision/issue reference')
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(file)
  return issues
}

/**
 * Inspect tracked and newly added source without traversing installed artifacts.
 * @param root - repository root.
 * @returns all source violations.
 */
export function inspectRepositoryTestHonesty(root: string): TestHonestyIssue[] {
  const paths = execFileSync('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard', '--', '*.ts', '*.tsx', '*.mts', '*.cts'],
    { cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }).split('\0')
    .filter(path => /^(?:packages|apps|examples|scripts|gateway|plugins)\//.test(path)
      && !/(?:^|\/)(?:lib|dist|node_modules)\//.test(path) && !path.endsWith('.d.ts') && existsSync(resolve(root, path)))
  if (paths.length === 0) throw new Error('verify-test-honesty: source corpus is empty')
  return [...new Set(paths)].flatMap(path => inspectTestHonesty(path, readFileSync(resolve(root, path), 'utf8')))
}

function main(): void {
  const { values } = parseArgs({ options: { root: { type: 'string' } }, allowPositionals: false })
  const issues = inspectRepositoryTestHonesty(resolve(values.root ?? resolve(import.meta.dirname, '..')))
  if (issues.length > 0) {
    for (const issue of issues) console.error(`${issue.path}:${issue.line}: ${issue.rule}: ${issue.message}`)
    process.exitCode = 1
  } else {
    console.log('verify-test-honesty: coverage suppressions and unconditional skips are explained.')
  }
}

if (import.meta.main) main()
