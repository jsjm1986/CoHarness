/** ARIA comparison preserves prose and only redacts measurements in named UI statistics. */
import { isMap, isScalar, isSeq, parseDocument } from 'yaml'

type RuntimeScope = 'timing' | 'clock' | undefined

function runtimeScope(key: string): RuntimeScope {
  if (/^group "(?:Message timing|消息时间与速度)"$/.test(key)) return 'clock'
  if (/^(?:group|dialog) "(?:Session statistics|会话统计|Turn time and speed|本轮用时和速度)"$/.test(key)) return 'timing'
  return undefined
}

function normalizeMeasurement(value: string, scope: RuntimeScope): string {
  if (scope === undefined) return value
  let result = value
    .replace(/\b(?:\d+d(?: \d+h(?: \d+m \d+s)?)?|\d+h \d+m \d+s|\d+m ?\d+s|\d+(?:\.\d+)?s|\d+(?:\.\d+)?ms)\b/g, '{{duration}}')
    .replace(/\b\d[\d,]*(?:\.\d+)? ms\b/g, '{{duration}}')
    .replace(/\d+(?:天(?:\d+小时(?:\d+分\d+秒)?)?|小时\d+分\d+秒|分\d+秒|(?:\.\d+)?秒)/g, '{{duration}}')
    .replace(/\d+(?:\.\d+)?(?= tok\/s(?!\w))/g, '{{throughput}}')
  if (scope === 'clock') {
    result = result
      .replace(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z/g, '{{timestamp}}')
      .replace(/(?:\d{4}年)?\d{1,2}月\d{1,2}日 \d{2}:\d{2}/g, '{{clock}}')
      .replace(/(?:\d{1,2}\/\d{1,2}(?:\/\d{2,4})? )?\d{1,2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:\s*[AP]M)?/gi, '{{clock}}')
  }
  return result
}

function replacePath(value: string, path: string, token: string): string {
  if (path === '') return value
  const escaped = path.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return value.replace(new RegExp(`(?<![\\w/\\\\-])${escaped}(?![\\w.-])`, 'g'), token)
}

/**
 * Normalize declared temporary paths and named timing groups without changing body text.
 * @param snapshot - Playwright's default YAML ARIA snapshot.
 * @param workspaceCwd - The scenario-owned temporary workspace.
 * @returns The same YAML, with changed scalars quoted and all other bytes retained.
 */
export function normalizeAria(snapshot: string, workspaceCwd: string): string {
  const document = parseDocument(snapshot)
  if (document.errors.length > 0) throw new Error(`invalid ARIA snapshot: ${document.errors[0]!.message}`)
  const edits: { start: number; end: number; value: string }[] = []
  const base = workspaceCwd.split(/[\\/]/).pop() ?? ''
  const visit = (node: unknown, scope: RuntimeScope): void => {
    if (isScalar(node) && typeof node.value === 'string') {
      let value = replacePath(node.value, workspaceCwd, '{{cwd}}')
      value = replacePath(value, base, '{{workspace}}')
      // Minted session/agent ids reach prose (a child's parent-agent
      // instructions quote the parent id verbatim), so collapse them like
      // paths rather than leaving them to a scope. Bare uuids stay literal:
      // business identifiers are content, covered by seeded-history's
      // normalize-preserves-identifiers case.
      value = value.replace(/session-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, 'session-{{uuid}}')
      // Trajectory tooltips and similar chrome print seeded event times in
      // the runner's local zone (HH:MM:SS AM/PM); they are wall-clock output
      // even outside a timing group, while bare HH:MM deadlines in message
      // text stay literal.
      value = value.replace(/\d{1,2}:\d{2}:\d{2}(?:\.\d+)?\s*[AP]M/gi, '{{clock}}')
      // The compaction badge's ~N tokens is priced from seeded content that
      // embeds the workspace path, whose length varies by platform tmpdir.
      value = value.replace(/~\d[\d,]* tokens/g, '~{{tokens}} tokens')
      value = normalizeMeasurement(value, scope)
      if (value !== node.value) {
        if (node.range == null) throw new Error('ARIA scalar has no source range')
        edits.push({ start: node.range[0], end: node.range[1], value: JSON.stringify(value) })
      }
    } else if (isSeq(node)) {
      for (const item of node.items) visit(item, scope)
    } else if (isMap(node)) {
      for (const pair of node.items) {
        const childScope = isScalar(pair.key) && typeof pair.key.value === 'string'
          ? runtimeScope(pair.key.value) ?? scope
          : scope
        visit(pair.key, scope)
        visit(pair.value, childScope)
      }
    }
  }
  visit(document.contents, undefined)
  let result = snapshot
  for (const edit of edits.sort((a, b) => b.start - a.start)) {
    result = result.slice(0, edit.start) + edit.value + result.slice(edit.end)
  }
  return result
}
