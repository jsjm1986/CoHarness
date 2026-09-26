/** Exercise the CI preflight against real shallow Git repositories with a local transport. */
import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'

const upstreamUrl = 'https://github.com/deepseek-ai/deepseek-harness.git'
const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'pinned-upstream-inputs-'))
  roots.push(root)
  const source = join(root, 'upstream')
  const consumer = join(root, 'consumer')
  const git = (cwd: string, ...args: string[]): string => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
  for (const directory of [source, consumer]) {
    mkdirSync(directory)
    git(directory, 'init', '-q')
  }
  const commit = (contents: string): string => {
    writeFileSync(join(source, 'input.txt'), contents)
    git(source, 'add', '.')
    git(source, '-c', 'user.name=Upstream fixture', '-c', 'user.email=upstream@example.invalid', '-c', 'commit.gpgsign=false',
      '-c', `core.hooksPath=${join(root, '.hooks')}`, 'commit', '-qm', 'input')
    return git(source, 'rev-parse', 'HEAD')
  }
  const unrequested = commit('older history\n')
  const baseline = commit('baseline\n')
  const increment = commit('increment\n')
  const target = commit('target\n')
  const tag = 'dsh-vfixture'
  git(source, 'tag', 'dsh-vbaseline', baseline)
  git(source, 'tag', 'dsh-vincrement', increment)
  git(source, 'tag', tag, target)
  // Git substitutes only the fixture transport. The script still invokes the
  // fixed public URL, and Git performs the real depth-limited object transfer.
  git(consumer, 'config', `url.${pathToFileURL(source).href}.insteadOf`, upstreamUrl)
  const write = (path: string, value: string | object): void => {
    mkdirSync(dirname(join(consumer, path)), { recursive: true })
    writeFileSync(join(consumer, path), typeof value === 'string' ? value : JSON.stringify(value))
  }
  const matrixPath = `upgrades/alignment/UPSTREAM-ALIGNMENT-MATRIX-${tag}.json`
  const matrix = { baseline: { commit: baseline }, incrementBaseline: { commit: increment }, target: { tag, commit: target } }
  write('scripts/upstream-sync.json', { syncedTag: tag, syncedCommit: target })
  write(matrixPath, matrix)
  write('scripts/fetch-upstream-baseline.ts', readFileSync(new URL('./fetch-upstream-baseline.ts', import.meta.url), 'utf8'))
  const trace = join(root, 'git-trace.jsonl')
  const run = () => {
    const result = spawnSync(process.execPath, [join(consumer, 'scripts/fetch-upstream-baseline.ts')], {
      cwd: consumer, encoding: 'utf8', timeout: 30_000, env: { ...process.env, GIT_TRACE2_EVENT: trace },
    })
    expect(result.error).toBeUndefined()
    expect(result.signal).toBeNull()
    return { status: result.status, output: result.stdout + result.stderr }
  }
  const fetches = (): string[][] => !existsSync(trace) ? [] : readFileSync(trace, 'utf8').trim().split('\n')
    .map(line => JSON.parse(line) as { event: string; argv?: string[] })
    .filter(record => record.event === 'start' && record.argv?.[1] === 'fetch')
    .map(record => (record.argv as string[]).slice(1))
  const hasCommit = (sha: string): boolean => spawnSync('git', ['cat-file', '-e', `${sha}^{commit}`], { cwd: consumer, stdio: 'ignore' }).status === 0
  return { source, consumer, git, write, matrixPath, matrix, tag, baseline, increment, target, unrequested, run, fetches, hasCommit }
}

describe('pinned upstream CI preflight', () => {
  it('fetches all three declared snapshots once and leaves older unrequested history absent', () => {
    const f = fixture()
    expect([f.baseline, f.increment, f.target].map(f.hasCommit)).toEqual([false, false, false])
    const prepared = f.run()
    expect(prepared.status, prepared.output).toBe(0)
    expect([f.baseline, f.increment, f.target].map(f.hasCommit)).toEqual([true, true, true])
    expect(f.hasCommit(f.unrequested)).toBe(false)
    expect(f.git(f.consumer, 'diff', '--name-only', '--no-renames', f.baseline, f.target)).toBe('input.txt')
    expect(f.git(f.consumer, 'diff', '--name-only', '--no-renames', f.increment, f.target)).toBe('input.txt')
    expect(f.fetches()).toEqual([
      ['fetch', '--depth=1', '--no-tags', upstreamUrl, `refs/tags/${f.tag}:refs/tags/${f.tag}`],
      ['fetch', '--depth=1', '--no-tags', upstreamUrl, f.baseline],
      ['fetch', '--depth=1', '--no-tags', upstreamUrl, f.increment],
    ])
    const repeated = f.run()
    expect(repeated.status, repeated.output).toBe(0)
    expect(f.fetches()).toHaveLength(3)
  })

  it.each(['baseline', 'incrementBaseline'] as const)('rejects an invalid %s SHA before fetching', (field) => {
    const f = fixture()
    f.write(f.matrixPath, { ...f.matrix, [field]: { commit: 'HEAD' } })
    const result = f.run()
    expect(result.status, result.output).toBe(1)
    expect(result.output).toContain('invalid')
    expect(f.fetches()).toEqual([])
  })

  it('rejects a matrix whose target differs from the synchronization pin', () => {
    const f = fixture()
    f.write(f.matrixPath, { ...f.matrix, target: { tag: f.tag, commit: f.baseline } })
    const result = f.run()
    expect(result.status, result.output).toBe(1)
    expect(result.output).toContain('matrix target differs')
    expect(f.fetches()).toEqual([])
  })

  it('fails when a declared comparison commit is unavailable upstream', () => {
    const f = fixture()
    const unavailable = '0'.repeat(40)
    f.write(f.matrixPath, { ...f.matrix, baseline: { commit: unavailable } })
    const result = f.run()
    expect(result.status, result.output).toBe(1)
    expect(f.fetches().at(-1)).toEqual(['fetch', '--depth=1', '--no-tags', upstreamUrl, unavailable])
    expect(f.hasCommit(unavailable)).toBe(false)
  })

  it('refuses to replace an existing local tag with a different identity', () => {
    const f = fixture()
    f.git(f.consumer, 'fetch', '--depth=1', '--no-tags', upstreamUrl, f.baseline)
    f.git(f.consumer, 'tag', f.tag, f.baseline)
    const result = f.run()
    expect(result.status, result.output).toBe(1)
    expect(result.output).toContain('fetched tag differs from the pinned commit')
    expect(f.git(f.consumer, 'rev-parse', `${f.tag}^{commit}`)).toBe(f.baseline)
    expect(f.fetches()).toEqual([])
  })
})
