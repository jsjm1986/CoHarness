/** Surface replay expectation changes for semantic review in the existing CI summary. */
import { execFileSync } from 'node:child_process'
import { appendFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { parseArgs } from 'node:util'
import { scanGoldenOwners } from './web-test-policy.ts'

/** Select replay fixtures even when the expected content uses Markdown.
 * @param paths - complete changed-path set, including both rename sides.
 * @returns changed expected outputs and recorded replay inputs.
 */
export function changedGoldenPaths(paths: readonly string[]): string[] {
  return paths.filter(path => path.startsWith('snapshots/') || path.includes('/snapshots/') || /\.expected\.(?:md|json|txt|html)$/.test(path))
}

if (import.meta.main) {
  const { values } = parseArgs({ options: { base: { type: 'string' }, replay: { type: 'string', default: 'pending' } }, allowPositionals: false })
  if (!values.base) throw new Error('golden summary: --base is required')
  if (!['pending', 'success', 'failure', 'cancelled', 'skipped'].includes(values.replay)) throw new Error('golden summary: invalid replay status')
  const paths = execFileSync('git', ['diff', '--name-only', '--no-renames', `${values.base}...HEAD`], { encoding: 'utf8' }).trim().split('\n')
  const owners = scanGoldenOwners(resolve(import.meta.dirname, '..'))
  const changed = changedGoldenPaths(paths)
  const lines = ['### Replay expectations', '', `Execution result: ${values.replay}.`, '']
  if (changed.length === 0) lines.push('No golden or recorded replay input changed.')
  else {
    lines.push('Review each expectation change against the behavior description in the PR. Refresh commands do not provide semantic approval.', '', '| Changed fixture | Owning scenario |', '| --- | --- |')
    for (const path of changed) {
      const web = /^apps\/web\/tests\/snapshots\/([^/]+)\//.exec(path)
      const scenarios = web?.[1] ? owners.get(web[1]) : undefined
      lines.push(`| ${path.replaceAll('|', '\\|')} | ${scenarios?.join(', ') ?? 'ACP/CLI replay or full fallback; confirm owning scenario in review'} |`)
    }
  }
  const markdown = lines.join('\n') + '\n'
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, markdown)
  else process.stdout.write(markdown)
}
