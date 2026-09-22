/** Validate selected recorded Sessions before building or starting browser scenarios. */
import { existsSync, globSync, readFileSync } from 'node:fs'
import { basename, dirname, relative, resolve } from 'node:path'
import { parseArgs } from 'node:util'
import ts from 'typescript'
import { parseSessionLog } from '@deepseek-ai/dsh-llm-replay'
import { createWebSnapshotPlan } from './run-web-snapshots.ts'
import { scanGoldenOwners, WEB_TESTS_ROOT } from './web-test-policy.ts'

/** A malformed recorded Session and its parser diagnostic. */
export interface WebFixtureProblem {
  readonly path: string
  readonly message: string
}

/** Selected Session files and every detected admission failure. */
export interface WebFixtureInspection {
  readonly files: readonly string[]
  readonly problems: readonly WebFixtureProblem[]
}

/**
 * Decode every recorded Session owned by the selected browser scenarios.
 * Non-Session JSONL, such as wire-output goldens, remains owned by its scenario.
 * @param root - repository containing the scenario inventory.
 * @param scenarios - validated scenario keys relative to apps/web/tests.
 * @returns inspected Session files and all admission failures, without writes.
 */
export function inspectWebFixtures(root: string, scenarios: readonly string[]): WebFixtureInspection {
  const selected = new Set(scenarios)
  const directories = [...scanGoldenOwners(root)]
    .filter(([, owners]) => owners.some(owner => selected.has(owner)))
    .map(([directory]) => directory)
  const paths = new Set<string>()
  for (const directory of directories) {
    for (const path of globSync('**/*.jsonl', { cwd: resolve(root, 'apps/web/tests/snapshots', directory) })) {
      paths.add(resolve(root, 'apps/web/tests/snapshots', directory, path))
    }
  }
  const files: string[] = []
  const problems: WebFixtureProblem[] = []
  for (const scenario of scenarios) {
    const entry = resolve(root, WEB_TESTS_ROOT, scenario)
    const source = ts.createSourceFile(entry, readFileSync(entry, 'utf8'), ts.ScriptTarget.Latest, true)
    const visit = (node: ts.Node): void => {
      if ((ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node))
        && /^(?:\.\.?\/)*snapshots\/[^\n]+\.jsonl$/.test(node.text)) {
        const target = resolve(dirname(entry), node.text)
        if (!existsSync(target)) problems.push({
          path: relative(root, target).replaceAll('\\', '/'),
          message: `missing recorded input referenced by ${scenario}`,
        })
      }
      ts.forEachChild(node, visit)
    }
    visit(source)
  }
  for (const path of [...paths].sort()) {
    const name = relative(root, path).replaceAll('\\', '/')
    const source = readFileSync(path, 'utf8')
    const first = source.split(/\r?\n/).find(line => line.trim().length > 0)
    const requiresSession = /^(?:session(?:\.\d+)?|seed)(?:\.v\d+)?\.jsonl$/.test(basename(path))
    if (first === undefined) {
      if (requiresSession) problems.push({ path: name, message: 'recorded Session is empty' })
      continue
    }
    let header: unknown
    try {
      header = JSON.parse(first) as unknown
    } catch (error: unknown) {
      problems.push({ path: name, message: 'invalid JSONL header: ' + String(error) })
      continue
    }
    if (header === null || typeof header !== 'object' || Array.isArray(header)
      || !('type' in header) || header.type !== 'session') {
      if (requiresSession) problems.push({ path: name, message: 'recorded Session has no Session header' })
      continue
    }
    files.push(name)
    try {
      parseSessionLog(source)
    } catch (error: unknown) {
      problems.push({ path: name, message: error instanceof Error ? error.message : String(error) })
    }
  }
  return { files, problems }
}

function main(): number {
  const { values, tokens } = parseArgs({
    options: {
      root: { type: 'string' },
      focused: { type: 'boolean' },
      scenarios: { type: 'string' },
      groups: { type: 'string' },
    },
    tokens: true,
    strict: true,
  })
  const root = resolve(values.root ?? resolve(import.meta.dirname, '..'))
  const args = tokens.flatMap((token) => {
    if (token.kind !== 'option' || token.name === 'root') return []
    return token.value === undefined ? [token.rawName] : [`--${token.name}=${token.value}`]
  })
  const plan = createWebSnapshotPlan(root, args, process.env)
  const result = inspectWebFixtures(root, plan.scenarios)
  for (const problem of result.problems) console.error(`${problem.path}: ${problem.message}`)
  console.log(`web fixtures: ${result.files.length} Session files, ${result.problems.length} admission failures`)
  return result.problems.length === 0 ? 0 : 1
}

if (import.meta.main) process.exitCode = main()
