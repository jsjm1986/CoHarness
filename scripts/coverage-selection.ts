/** Apply the Vitest measurement patterns to repository-relative source paths. */
import { globSync, readFileSync } from 'node:fs'
import { posix, resolve } from 'node:path'
import ts from 'typescript'

/** The include/exclude lists owned by the active Vitest coverage configuration. */
export interface CoverageSelection {
  readonly include: readonly string[]
  readonly exclude: readonly string[]
}

/** Failed executable lint fixtures may leave a transient source file with this name. */
export const COVERAGE_LINT_PROBE = 'packages/*/*/src/oxlint-contract-*.ts'

/** Identify modules whose explicit syntax emits no runtime statements.
 * @param path - source name for TS/TSX parsing.
 * @param source - current source text.
 * @returns true only for an entirely type-only module; uncertain forms remain measured.
 */
export function isPureTypeSource(path: string, source: string): boolean {
  const file = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true, path.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS)
  const erased = (statement: ts.Statement): boolean => {
    if (ts.isInterfaceDeclaration(statement) || ts.isTypeAliasDeclaration(statement) || ts.isEmptyStatement(statement)) return true
    if (ts.canHaveModifiers(statement)
      && ts.getModifiers(statement)?.some(modifier => modifier.kind === ts.SyntaxKind.DeclareKeyword)) return true
    if (ts.isImportDeclaration(statement)) {
      const clause = statement.importClause
      if (clause?.phaseModifier === ts.SyntaxKind.TypeKeyword) return true
      return clause?.name === undefined && clause?.namedBindings !== undefined && ts.isNamedImports(clause.namedBindings)
        && clause.namedBindings.elements.length > 0 && clause.namedBindings.elements.every(element => element.isTypeOnly)
    }
    if (ts.isExportDeclaration(statement)) {
      if (statement.isTypeOnly) return true
      return statement.exportClause !== undefined && ts.isNamedExports(statement.exportClause)
        && (statement.exportClause.elements.length > 0 || statement.moduleSpecifier === undefined)
        && statement.exportClause.elements.every(element => element.isTypeOnly)
    }
    return false
  }
  if (file.statements.every(erased)) return true
  if (!file.statements.every(statement =>
    erased(statement) || ts.isImportDeclaration(statement) || ts.isExportDeclaration(statement))) return false
  // With verbatimModuleSyntax=false, imports used only in types and local type
  // re-exports also erase. Inspect the compiler output rather than adding names.
  const emitted = ts.transpileModule(source, {
    fileName: path,
    compilerOptions: { target: ts.ScriptTarget.ESNext, module: ts.ModuleKind.ESNext, verbatimModuleSyntax: false },
  }).outputText
  const javascript = ts.createSourceFile(path + '.js', emitted, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS)
  return javascript.statements.every(statement => ts.isEmptyStatement(statement)
    || (ts.isExportDeclaration(statement) && statement.moduleSpecifier === undefined
      && statement.exportClause !== undefined && ts.isNamedExports(statement.exportClause) && statement.exportClause.elements.length === 0))
}

/** Derive type-only exclusions without another maintained filename list.
 * @param root - source checkout.
 * @param selection - existing runtime measurement policy.
 * @returns source paths whose declarations have no emitted runtime work.
 */
export function pureTypeCoverageSources(root: string, selection: CoverageSelection): string[] {
  return selectCoverageSources(globSync([...selection.include], { cwd: root }), selection)
    .filter(path => isPureTypeSource(path, readFileSync(resolve(root, path), 'utf8')))
}

/**
 * Select runtime source using the same patterns as the instrumented run.
 * @param paths - repository-relative changed or discovered paths.
 * @param selection - the active coverage configuration.
 * @returns unique measured paths in deterministic order.
 */
export function selectCoverageSources(paths: readonly string[], selection: CoverageSelection): string[] {
  return [...new Set(paths.map(path => path.replaceAll('\\', '/')).filter(path =>
    !path.endsWith('.d.ts')
    && selection.include.some(pattern => posix.matchesGlob(path, pattern))
    && !selection.exclude.some(pattern => posix.matchesGlob(path, pattern)),
  ))].sort()
}

/**
 * Reject stale exclusions while allowing the explicitly temporary lint probe.
 * @param root - repository root to inspect.
 * @param selection - the active coverage configuration.
 * @returns exclusion patterns which match no current source.
 */
export function staleCoverageExclusions(root: string, selection: CoverageSelection): string[] {
  const sources = [...globSync([...selection.include], { cwd: root })]
  if (sources.length === 0) throw new Error('coverage selection: source corpus is empty')
  return selection.exclude.filter(pattern =>
    pattern !== COVERAGE_LINT_PROBE
    && !sources.some(path => posix.matchesGlob(path.replaceAll('\\', '/'), pattern)),
  )
}
