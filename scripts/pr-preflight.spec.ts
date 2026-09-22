import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { planPrPreflight, type PrPreflightReport } from './pr-preflight.ts'

const repository = resolve(import.meta.dirname, '..')
const cli = resolve(import.meta.dirname, 'pr-preflight.ts')
const tsx = createRequire(import.meta.url).resolve('tsx/cli')
const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })

function write(root: string, path: string, data: unknown): void {
  mkdirSync(dirname(join(root, path)), { recursive: true })
  writeFileSync(join(root, path), typeof data === 'string' ? data : JSON.stringify(data, null, 2) + '\n')
}
function git(root: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
}
function commit(root: string): string {
  git(root, 'add', '.')
  git(root, 'commit', '-qm', 'fixture')
  return git(root, 'rev-parse', 'HEAD')
}

function fixture(): { root: string; base: string } {
  const root = mkdtempSync(join(tmpdir(), 'pr-preflight-'))
  roots.push(root)
  git(root, 'init', '-q')
  git(root, 'config', 'user.name', 'Preflight fixture')
  git(root, 'config', 'user.email', 'preflight@example.invalid')
  git(root, 'config', 'commit.gpgsign', 'false')
  const hooks = join(root, '.git/empty-hooks')
  mkdirSync(hooks)
  git(root, 'config', 'core.hooksPath', hooks)
  write(root, '.gitignore', 'node_modules\n.artifacts/\n')
  mkdirSync(join(root, 'packages'))
  const scripts = Object.fromEntries(Object.keys((JSON.parse(readFileSync(join(repository, 'package.json'), 'utf8')) as { scripts: Record<string, string> }).scripts)
    .map(name => [name, 'node scripts/product-check.mjs']))
  write(root, 'package.json', { type: 'module', scripts })
  write(root, 'scripts/product-check.mjs', "import {writeFileSync} from 'node:fs'; writeFileSync('.product-check-ran', 'unexpected')\n")
  const policy = JSON.parse(readFileSync(join(repository, 'scripts/ci-consumer-relations.json'), 'utf8')) as {
    lanes: Record<string, { manifest: string; scripts: string[]; workflow: string; jobs: string[]; sources: string[] }>
  }
  write(root, 'scripts/ci-consumer-relations.json', policy)
  const workflows = new Map<string, Record<string, unknown>>()
  for (const lane of Object.values(policy.lanes)) {
    if (lane.manifest !== 'package.json') write(root, lane.manifest, { scripts: Object.fromEntries(lane.scripts.map(script => [script, 'node -e "void 0"'])) })
    const jobs = workflows.get(lane.workflow) ?? {}
    for (const job of lane.jobs) jobs[job] = { steps: [{ uses: 'pnpm/action-setup@v6.0.9' }] }
    workflows.set(lane.workflow, jobs)
    for (const path of lane.sources) if (!existsSync(join(root, path))) write(root, path, '// fixture entry\n')
  }
  for (const [path, jobs] of workflows) write(root, path, { jobs })
  for (const file of ['release.yml', 'release-vendor.yml', 'landlock-run.yml', 'sandbox.yml', 'e2e.yml', 'pi-ai-provider-e2e.yml']) {
    write(root, `.github/workflows/${file}`, readFileSync(join(repository, '.github/workflows', file), 'utf8'))
  }
  // The fixture supplies only mechanical check commands; product checks expose accidental execution.
  for (const path of ['scripts/ci-consumer-relations.ts', 'scripts/run-web-snapshots.ts', 'scripts/verify-translation-pairing.ts', 'scripts/gen-third-party-notices.ts']) {
    write(root, path, "process.stdout.write('mechanical check\\n')\n")
  }
  write(root, 'scripts/web-test-policy.json', { version: 1, groups: ['smoke', 'conversation'],
    scenarios: { 'smoke.e2e.ts': 'smoke', 'subject.e2e.ts': 'conversation' }, packages: {}, fullPrefixes: [], webInfraPrefixes: [],
    smokeScenarios: ['smoke.e2e.ts'], unknown: 'full' })
  write(root, 'apps/web/tests/smoke.e2e.ts', '// smoke\n')
  write(root, 'apps/web/tests/subject.e2e.ts', "const golden = 'snapshots/subject'\n")
  write(root, 'scripts/translation-pairing.manifest.json', { excluded: [] })
  write(root, 'docs/guide.md', '# Guide\n')
  write(root, 'docs/guide.zh.md', '# 指南\n')
  write(root, 'docs/guide.i18n.yaml', 'fixture record\n')
  const base = commit(root)
  return { root, base }
}

function invoke(root: string, args: string[]) {
  return spawnSync(process.execPath, [tsx, cli, ...args], { cwd: root, encoding: 'utf8', timeout: 30_000,
    env: { ...process.env, DSH_CI_SCOPE_POLICY: 'candidate' }, maxBuffer: 8 * 1024 * 1024 })
}
function plan(base: string, root: string): PrPreflightReport {
  return planPrPreflight(base, root, { DSH_CI_SCOPE_POLICY: 'candidate' })
}
function state(root: string): { head: string; index: string; status: string } {
  return { head: git(root, 'rev-parse', 'HEAD'), index: readFileSync(join(root, '.git/index')).toString('base64'), status: git(root, 'status', '--porcelain=v2', '-z') }
}

describe('local PR preflight', () => {
  it('requires an explicit unambiguous base through the actual CLI', { timeout: 30_000 }, () => {
    const { root } = fixture()
    for (const args of [[], ['--base', 'absent'], ['--base', 'HEAD', '--check', '--fix-generated']]) {
      const before = state(root)
      const result = invoke(root, args)
      expect(result.error).toBeUndefined()
      expect(result.status).toBe(1)
      expect(result.stderr).toContain('pr-preflight:')
      expect(state(root)).toEqual(before)
    }
  })

  it('includes committed, staged, unstaged and untracked inputs without changing repository state', () => {
    const { root, base } = fixture()
    write(root, 'committed-runtime.unknown', 'committed\n')
    commit(root)
    write(root, 'staged-runtime.unknown', 'staged\n')
    git(root, 'add', 'staged-runtime.unknown')
    write(root, 'docs/guide.md', '# Revised guide\n')
    write(root, 'untracked-runtime.unknown', 'untracked\n')
    const before = state(root)
    const report = plan(base, root)
    expect(report.scope.paths).toMatchObject({ committed: ['committed-runtime.unknown'], staged: ['staged-runtime.unknown'], unstaged: ['docs/guide.md'], untracked: ['untracked-runtime.unknown'] })
    expect(report.paths).toEqual(['committed-runtime.unknown', 'docs/guide.md', 'staged-runtime.unknown', 'untracked-runtime.unknown'])
    expect(report.runtimeSelection).toMatchObject({ reason: 'full', coverageMode: 'full' })
    expect(report.validation).toEqual({ mechanical: 'not-run', productChecks: 'not-run' })
    expect(report.localEvidence.reusable).toBe(false)
    expect(state(root)).toEqual(before)
  })

  it('keeps documentation-only paths narrow and reports complete named pairs', () => {
    const { root, base } = fixture()
    write(root, 'docs/guide.md', '# Revised guide\n')
    const report = plan(base, root)
    expect(report.diagnostics).toEqual([])
    expect(report.runtimeSelection).toMatchObject({ reason: 'docs-only', coverageMode: 'skip', windowsMode: 'skip' })
    expect(report.requiredCommands.map(command => command.id)).not.toContain('coverage')
    expect(report.translationPairs).toEqual([{ source: 'docs/guide.md', zh: 'docs/guide.zh.md', meta: 'docs/guide.i18n.yaml', missing: [] }])
  })

  it('reports all missing entries and scripts together rather than stopping at the first consumer', () => {
    const { root, base } = fixture()
    rmSync(join(root, 'gateway/tests/runtime-api.spec.ts'))
    rmSync(join(root, 'gateway/tests/server.spec.ts'))
    rmSync(join(root, 'docs/guide.zh.md'))
    write(root, 'docs/guide.md', '# Changed guide\n')
    const manifest = JSON.parse(readFileSync(join(root, 'gateway/package.json'), 'utf8')) as { scripts: Record<string, string> }
    delete manifest.scripts.typecheck
    delete manifest.scripts.test
    write(root, 'gateway/package.json', manifest)
    const report = plan(base, root)
    expect(report.diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'missing-entry', path: 'gateway/tests/runtime-api.spec.ts' }),
      expect.objectContaining({ code: 'missing-entry', path: 'gateway/tests/server.spec.ts' }),
      expect.objectContaining({ code: 'missing-script', message: 'Missing public script typecheck.' }),
      expect.objectContaining({ code: 'missing-script', message: 'Missing public script test.' }),
      expect.objectContaining({ code: 'missing-translation-pair', path: 'docs/guide.zh.md' }),
    ]))
  })

  it('rejects nested missing scripts and missing mechanical entries through the real CLI', { timeout: 30_000 }, () => {
    const { root, base } = fixture()
    write(root, 'docs/guide.md', '# Changed guide\n')
    const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as { scripts: Record<string, string> }
    manifest.scripts['test:docs'] = 'npm run nonexistent-doc-check'
    write(root, 'package.json', manifest)
    rmSync(join(root, 'scripts/verify-translation-pairing.ts'))
    const result = invoke(root, ['--base', base])
    expect(result.status).toBe(1)
    const report = JSON.parse(result.stdout) as PrPreflightReport
    expect(report.diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'missing-script', message: 'Missing public script nonexistent-doc-check.' }),
      expect.objectContaining({ code: 'missing-entry', path: 'scripts/verify-translation-pairing.ts' }),
    ]))
    expect(existsSync(join(root, '.product-check-ran'))).toBe(false)
  })

  it('uses exact browser owners and smoke scenarios from the shared selector', () => {
    const { root, base } = fixture()
    write(root, 'apps/web/tests/snapshots/subject/output.md', 'changed expected output\n')
    const report = plan(base, root)
    expect(report.runtimeSelection?.snapshotMode).toBe('focused')
    const web = report.requiredCommands.find(command => command.id === 'web')
    expect(JSON.parse(web?.env.DSH_WEB_SCENARIOS ?? 'null')).toEqual(['smoke.e2e.ts', 'subject.e2e.ts'])
  })

  it('checks mechanical inputs without executing product checks or recording translations', { timeout: 30_000 }, () => {
    const { root, base } = fixture()
    symlinkSync(join(repository, 'node_modules'), join(root, 'node_modules'), process.platform === 'win32' ? 'junction' : 'dir')
    write(root, 'docs/guide.md', '# Revised guide\n')
    const before = state(root)
    const record = readFileSync(join(root, 'docs/guide.i18n.yaml'), 'utf8')
    const result = invoke(root, ['--base', base, '--check'])
    expect(result.stderr).toBe('')
    expect(result.status).toBe(0)
    const report = JSON.parse(result.stdout) as PrPreflightReport
    expect(report.validation).toEqual({ mechanical: 'passed', productChecks: 'not-run' })
    expect(report.executedChecks.map(check => check.id)).toEqual(['consumer-references', 'translation-pairing'])
    expect(existsSync(join(root, '.product-check-ran'))).toBe(false)
    expect(readFileSync(join(root, 'docs/guide.i18n.yaml'), 'utf8')).toBe(record)
    expect(state(root)).toEqual(before)
  })

  it('keeps the conservative shadow execution visible when a private clone lacks the frozen history', () => {
    const { root, base } = fixture()
    write(root, 'docs/guide.md', '# Revised guide\n')
    const report = planPrPreflight(base, root, {})
    expect(report.diagnostics).toEqual([])
    expect(report.selectionPlans).toMatchObject({ policy: 'shadow', baselineStatus: 'unavailable',
      executionSource: 'shadow-union', candidate: { reason: 'docs-only', coverageMode: 'skip' }, execution: { coverageMode: 'full' } })
    expect(report.runtimeSelection).toEqual(report.selectionPlans?.execution)
    expect(report.requiredCommands.some(command => command.id === 'coverage')).toBe(true)
    expect(report.selectionPlans?.changes.removed.length).toBeGreaterThan(0)
  })

  it('rejects a stale generated alias, then repairs only the registered output when explicitly requested', { timeout: 30_000 }, () => {
    const { root } = fixture()
    symlinkSync(join(repository, 'node_modules'), join(root, 'node_modules'), process.platform === 'win32' ? 'junction' : 'dir')
    write(root, 'packages/util/probe/package.json', { name: '@deepseek-ai/dsh-probe' })
    write(root, 'packages/util/probe/src/index.ts', 'export const probe = true\n')
    write(root, 'tsconfig.base.json', '{\n  "compilerOptions": {\n    "paths": {\n      // BEGIN generated package aliases — pnpm run gen-tsconfig-paths\n      // END generated package aliases\n    }\n  }\n}\n')
    const source = readFileSync(join(repository, 'scripts/gen-tsconfig-paths.ts'), 'utf8')
    write(root, 'scripts/gen-tsconfig-paths.ts', source)
    const base = commit(root)
    write(root, 'scripts/gen-tsconfig-paths.ts', source + '\n// fixture input changed\n')
    const index = readFileSync(join(root, '.git/index')).toString('base64')
    const refused = invoke(root, ['--base', base, '--check'])
    expect(refused.status).toBe(1)
    const failed = JSON.parse(refused.stdout) as PrPreflightReport
    expect(failed.generated).toEqual([expect.objectContaining({ id: 'tsconfig-paths', status: 'failed' })])
    const repaired = invoke(root, ['--base', base, '--fix-generated'])
    expect(repaired.stderr).toBe('')
    expect(repaired.status).toBe(0)
    const report = JSON.parse(repaired.stdout) as PrPreflightReport
    expect(report.repairedGenerators.map(result => result.id)).toEqual(['tsconfig-paths'])
    expect(report.generated).toEqual([expect.objectContaining({ id: 'tsconfig-paths', status: 'passed' })])
    expect(report.scope.paths.unstaged).toContain('tsconfig.base.json')
    expect(readFileSync(join(root, 'tsconfig.base.json'), 'utf8')).toContain('@deepseek-ai/dsh-probe')
    expect(readFileSync(join(root, '.git/index')).toString('base64')).toBe(index)
    expect(existsSync(join(root, '.product-check-ran'))).toBe(false)
  })
})
