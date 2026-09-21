/** Explicit fork consumers for inputs that import-only selection cannot observe. */
import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { load as parse } from 'js-yaml'
import policy from './ci-consumer-relations.json' with { type: 'json' }

/** Independently executed fork consumer families. */
export type ConsumerLane = keyof typeof policy.lanes

/** Return rule IDs that justify each additional consumer.
 * @param paths - repository-relative changed inputs, including both rename sides.
 * @returns stable explanations, with empty arrays meaning no registered impact.
 */
export function consumerReasons(paths: readonly string[]): Record<ConsumerLane, string[]> {
  const result: Record<ConsumerLane, string[]> = { python: [], gateway: [], adminUi: [], android: [] }
  for (const relation of policy.relations) {
    if (!paths.some(path => relation.paths.some(prefix => path === prefix || path.startsWith(prefix + '/')))) continue
    for (const lane of relation.lanes as ConsumerLane[]) result[lane].push(relation.id)
  }
  // Cordis overlays, workers and process launchers can change runtime composition
  // without an import edge. Native build inputs have their own Android rule.
  if (paths.some(path => !path.startsWith('apps/android-shell/')
    && (/(?:^|\/)cordis[^/]*\.ya?ml$/.test(path) || /\/(?:worker|subprocess)[^/]*\.[cm]?ts$/.test(path)))) {
    for (const lane of Object.keys(result) as ConsumerLane[]) result[lane].push('dynamic-composition')
  }
  return result
}

/** Validate configured entry points before emitting any selection, even a docs-only one.
 * @param root - source checkout; generated output is deliberately not required.
 */
export function verifyConsumerReferences(root: string): void {
  if (policy.version !== 1 || policy.relations.length === 0) throw new Error('ci consumers: unsupported or empty policy')
  for (const relation of policy.relations) {
    if (relation.paths.length === 0 || relation.lanes.length === 0 || !relation.basis.trim()) throw new Error(`ci consumers: incomplete rule ${relation.id}`)
    for (const lane of relation.lanes) if (!Object.hasOwn(policy.lanes, lane)) throw new Error(`ci consumers: unknown lane ${lane}`)
  }
  if (new Set(policy.relations.map(row => row.id)).size !== policy.relations.length) throw new Error('ci consumers: duplicate rule IDs')
  for (const [lane, entry] of Object.entries(policy.lanes)) {
    const manifest = JSON.parse(readFileSync(resolve(root, entry.manifest), 'utf8')) as { scripts?: Record<string, string> }
    for (const script of entry.scripts) if (!manifest.scripts?.[script]) throw new Error(`ci consumers: ${lane} missing script ${script}`)
    const workflow = parse(readFileSync(resolve(root, entry.workflow), 'utf8')) as { jobs?: Record<string, unknown> }
    for (const job of entry.jobs) if (!workflow.jobs?.[job]) throw new Error(`ci consumers: ${lane} missing workflow job ${job}`)
    for (const source of entry.sources) if (!existsSync(resolve(root, source))) throw new Error(`ci consumers: ${lane} missing source ${source}`)
  }
}

if (import.meta.main) verifyConsumerReferences(resolve(import.meta.dirname, '..'))
