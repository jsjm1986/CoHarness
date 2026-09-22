/** Replay selection only; historical builds are intentionally outside this audit. */
import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { parseArgs } from 'node:util'
import { classifyCiPrScope, clientSurfacePackages, previousConsumerSelection, type CiPrScope } from './ci-pr-scope.ts'
import { loadWebTestPolicy, scanGoldenOwners } from './web-test-policy.ts'

/** One frozen historical parent/child comparison. */
export interface ScopeReplayRecord {
  readonly commit: string
  readonly base: string
  readonly paths: readonly string[]
  readonly selection: Omit<CiPrScope, 'androidMode' | 'consumerReasons'>
}

/** Classify a reduced consumer by an explicit, testable rule instead of a per-commit waiver.
 * @param lane - changed selector property.
 * @param paths - complete comparison path set.
 * @returns adjudication rule ID or undefined for an unexplained reduction.
 */
export function reducedConsumerRule(lane: string, paths: readonly string[]): string | undefined {
  const prefixes = lane === 'gatewayMode' ? ['gateway/', 'plugins/dsh-directory-guard/', 'plugins/dsh-model-governance/', 'packages/api/', 'packages/host/apiproxy/']
    : lane === 'adminUiMode' ? ['gateway/admin-ui/'] : []
  const reached = paths.filter(path => prefixes.some(prefix => path.startsWith(prefix)))
  return reached.length > 0 && reached.every(path => /\.(?:md|mdx|i18n\.yaml)$/.test(path))
    ? 'inert-consumer-documentation' : undefined
}

function main(): void {
  const { values } = parseArgs({ options: { baseline: { type: 'string' }, out: { type: 'string' } }, allowPositionals: false })
  if (!values.baseline || !values.out) throw new Error('scope replay: --baseline and --out are required')
  const baseline = JSON.parse(readFileSync(values.baseline, 'utf8')) as { formatVersion: number; head: string; records: ScopeReplayRecord[] }
  if (baseline.formatVersion !== 1 || baseline.records.length === 0) throw new Error('scope replay: empty or unsupported baseline')
  const root = resolve(import.meta.dirname, '..')
  const client = clientSurfacePackages(root)
  const policy = loadWebTestPolicy(root)
  const golden = scanGoldenOwners(root)
  const lanes = ['coverageMode', 'snapshotMode', 'compatMode', 'pythonMode', 'windowsMode', 'gatewayMode', 'adminUiMode', 'androidMode'] as const
  const differences: unknown[] = []
  const unexpected: string[] = []
  const groups: Record<string, number> = {}
  for (const entry of baseline.records) {
    const diff = entry.paths.every(path => path.startsWith('.github/workflows/'))
      ? execFileSync('git', ['diff', '--unified=0', entry.base, entry.commit], { cwd: root, encoding: 'utf8' }) : ''
    const next = classifyCiPrScope(entry.paths, diff, client, policy, golden)
    const previous = previousConsumerSelection(entry.paths, next)
    for (const key of Object.keys(entry.selection) as (keyof typeof entry.selection)[]) {
      if (JSON.stringify(previous[key]) !== JSON.stringify(entry.selection[key])) unexpected.push(`${entry.commit}: shadow baseline differs for ${key}`)
    }
    for (const lane of lanes) {
      const before = lane === 'androidMode' ? 'skip' : entry.selection[lane]
      const after = next[lane]
      if (before === after) continue
      const reduction = before !== 'skip' && after === 'skip'
      const consumer = lane === 'gatewayMode' ? 'gateway' : lane === 'adminUiMode' ? 'adminUi'
        : lane === 'pythonMode' ? 'python' : lane === 'androidMode' ? 'android' : undefined
      const reasons = reduction ? [reducedConsumerRule(lane, entry.paths)].filter(Boolean)
        : consumer === undefined ? [] : next.consumerReasons[consumer]
      if (reasons.length === 0) unexpected.push(`${entry.commit}: unexplained ${lane} ${before} → ${after}`)
      for (const reason of reasons) {
        const key = `${reduction ? 'reduce' : 'add'}:${lane}:${reason}`
        groups[key] = (groups[key] ?? 0) + 1
      }
      differences.push({ commit: entry.commit, lane, before, after, reasons })
    }
  }
  writeFileSync(values.out, JSON.stringify({ version: 1, baseline: baseline.head, commits: baseline.records.length,
    groups, unexplained: unexpected, differences }, null, 2) + '\n')
  console.log(JSON.stringify({
    commits: baseline.records.length, changedDecisions: differences.length, unexplained: unexpected.length, groups,
  }))
  if (unexpected.length > 0) process.exitCode = 1
}

if (import.meta.main) main()
