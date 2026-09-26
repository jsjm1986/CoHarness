/** Relationship-preserving identity redaction for committed session snapshots. */

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
// `goal-<uuid>` brands a minted uuid; the compound is unambiguous wherever it
// surfaces (goal/change state, goal_id arguments, result payloads).
const GOAL_COMPOUND_RE = /goal-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/gi
const LEGACY_TOKEN_RE = /^\{\{(?:sessionId|messageId)\}\}$/
const CANONICAL_TOKEN_RE = new RegExp(
  String.raw`^\{\{(session|message|approval|workflow|command|rpc|retry|compaction|`
  + String.raw`goal|principal|project|runtime|target|resource|id):([1-9]\d*)\}\}$`,
)

type IdentityKind = 'session' | 'message' | 'approval' | 'workflow' | 'command' | 'rpc' | 'retry'
  | 'compaction' | 'goal' | 'principal' | 'project' | 'runtime' | 'target' | 'resource' | 'id'

const FIELD_KINDS: Readonly<Record<string, IdentityKind>> = {
  sessionId: 'session', parentSessionId: 'session', rootSessionId: 'session', childId: 'session',
  messageId: 'message', participantId: 'principal', principalId: 'principal',
  projectId: 'project', runtimeId: 'runtime', executionTargetId: 'target', resourceId: 'resource',
}

const LITERAL_FIELDS = new Set(['content', 'args', 'arguments', 'parameters', 'schema', 'inputSchema', 'input_schema'])

interface ParsedLog {
  readonly records: Record<string, unknown>[]
  readonly trailingNewline: boolean
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function parseLog(log: string): ParsedLog {
  return {
    records: log.split(/\r?\n/)
      .filter(line => line.trim() !== '')
      .map(line => JSON.parse(line) as Record<string, unknown>),
    trailingNewline: log.endsWith('\n'),
  }
}

function messageId(value: unknown): string | undefined {
  if (!isRecord(value)
    || typeof value.id !== 'string'
    || typeof value.role !== 'string'
    || !Array.isArray(value.content)) return undefined
  return value.id
}

function redactedCandidate(value: string): boolean {
  return UUID_RE.test(value) || LEGACY_TOKEN_RE.test(value) || CANONICAL_TOKEN_RE.test(value)
}

/**
 * Replace volatile opaque ids while preserving equality relationships across a parent and its child logs.
 * @param logs - one scenario's primary-first session JSONL fixtures.
 * @returns compact JSONL with typed first-seen identity tokens.
 */
export function redactSessionSnapshotIds(logs: readonly string[]): string[] {
  const parsed = logs.map(parseLog)
  const tokenByValue = new Map<string, string>()
  const nextByKind = new Map<IdentityKind, number>()

  // Reserve existing ordinals before assigning any new identity. A later
  // canonical token must not alias a generated token from an earlier record.
  const reserve = (value: unknown): void => {
    if (typeof value === 'string') {
      const canonical = CANONICAL_TOKEN_RE.exec(value)
      if (canonical !== null) {
        const kind = canonical[1] as IdentityKind
        nextByKind.set(kind, Math.max(nextByKind.get(kind) ?? 0, Number(canonical[2])))
      }
    } else if (Array.isArray(value)) {
      value.forEach(reserve)
    } else if (isRecord(value)) {
      Object.values(value).forEach(reserve)
    }
  }
  parsed.forEach((log) => { log.records.forEach(reserve) })

  const claim = (value: unknown, kind: IdentityKind, always = false): void => {
    if (typeof value !== 'string' || value.length === 0 || tokenByValue.has(value)) return
    if (!always && !redactedCandidate(value)) return
    const canonical = CANONICAL_TOKEN_RE.exec(value)
    if (canonical !== null) {
      const canonicalKind = canonical[1] as IdentityKind
      const ordinal = Number(canonical[2])
      /* v8 ignore next -- reserve() already claimed an ordinal for every canonical token in the logs. */
      nextByKind.set(canonicalKind, Math.max(nextByKind.get(canonicalKind) ?? 0, ordinal))
      tokenByValue.set(value, value)
      return
    }
    const next = (nextByKind.get(kind) ?? 0) + 1
    nextByKind.set(kind, next)
    tokenByValue.set(value, `{{${kind}:${next}}}`)
  }

  const collect = (value: unknown, recordType?: unknown, inRpcParams = false): void => {
    if (Array.isArray(value)) {
      for (const item of value) collect(item, recordType, inRpcParams)
      return
    }
    if (!isRecord(value)) return

    const identifiedMessage = messageId(value)
    if (identifiedMessage !== undefined) claim(identifiedMessage, 'message')
    for (const [childKey, item] of Object.entries(value)) {
      if (LITERAL_FIELDS.has(childKey)) continue
      if (recordType === 'approval/asked' || recordType === 'approval/decided') {
        if (childKey === 'id') claim(item, 'approval')
      } else if (childKey === 'commandId') {
        claim(item, 'command', true)
      } else if (childKey === 'rpcId') {
        claim(item, 'rpc', true)
      } else if (childKey === 'retryId') {
        claim(item, 'retry')
      } else if (childKey === 'runId') {
        claim(item, 'workflow')
      } else if (FIELD_KINDS[childKey] !== undefined) {
        claim(item, FIELD_KINDS[childKey])
      } else if (inRpcParams && childKey === 'id') {
        claim(item, 'id')
      }
      collect(item, recordType, childKey === 'params')
    }
  }
  // Branded `goal-<uuid>` compounds sit inside literal payload strings that
  // collect skips (tool arguments, result text); mine every string directly.
  const mineGoalIds = (value: unknown): void => {
    if (typeof value === 'string') {
      for (const match of value.matchAll(GOAL_COMPOUND_RE)) {
        /* v8 ignore next -- the uuid capture is required whenever the goal-compound regex matches. */
        if (match[1] !== undefined) claim(match[1], 'goal')
      }
      return
    }
    if (Array.isArray(value)) {
      for (const item of value) mineGoalIds(item)
      return
    }
    if (isRecord(value)) for (const item of Object.values(value)) mineGoalIds(item)
  }
  // Claim each log's header before its records so a child catalog id seen in the
  // parent wins the earlier token — parallel child ids bind in catalog order,
  // not harvest order.
  for (const log of parsed) {
    const header = log.records[0]
    if (header?.type === 'session') claim(header.id, 'session', true)
    const feedbackCommands = new Set(log.records.flatMap(record =>
      record.type === 'command/run' && isRecord(record.data) && record.data.name === 'feedback'
        ? [record.data.commandId] : []))
    for (const record of log.records) {
      if (record.type === 'command/done' && isRecord(record.data)
        && feedbackCommands.has(record.data.commandId) && typeof record.data.text === 'string') {
        const anonymous = /^Feedback recorded for session [^\n]+\nAnonymous user: ([0-9a-f-]{36})\./i.exec(record.data.text)
        if (anonymous !== null) claim(anonymous[1], 'principal')
      }
      if (record.type === 'feedback/message-put' && isRecord(record.data) && isRecord(record.data.item)) {
        claim(record.data.item.version, 'id')
      }
      if ((record.type === 'compaction/start' || record.type === 'compaction/summary' || record.type === 'compaction/end')
        && isRecord(record.data)) {
        claim(record.data.compactionId, 'compaction')
      }
      mineGoalIds(record)
      collect(record, record.type)
    }
  }

  const replacements = [...tokenByValue]
    .sort(([left], [right]) => right.length - left.length)
  // A uuid stays one identity when carried inside a `prefix-<uuid>` compound
  // (session-<child id> agent handles, goal-<uuid> branding), so uuid sources
  // may abut `-`. Short readable ids keep the hyphen guard: `s` must not
  // rewrite `s-other`.
  const uuidSources = replacements.filter(([source]) => UUID_RE.test(source))
  const plainSources = replacements.filter(([source]) => !UUID_RE.test(source))
  const patternFor = (sources: [string, string][], hyphen: string): RegExp | undefined => sources.length === 0
    ? undefined
    : new RegExp(
      `(?<![\\w${hyphen}])(?:${sources.map(([source]) => source.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})(?![\\w${hyphen}])`,
      'g',
    )
  const uuidPattern = patternFor(uuidSources, '')
  const plainPattern = patternFor(plainSources, '-')
  const replace = (value: unknown): unknown => {
    if (typeof value === 'string') {
      const exact = tokenByValue.get(value)
      if (exact !== undefined) return exact
      let output = value
      if (uuidPattern !== undefined) output = output.replace(uuidPattern, source => tokenByValue.get(source) as string)
      if (plainPattern !== undefined) output = output.replace(plainPattern, source => tokenByValue.get(source) as string)
      return output
    }
    if (Array.isArray(value)) return value.map(replace)
    if (isRecord(value)) {
      return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, replace(item)]))
    }
    return value
  }

  return parsed.map((log) => {
    const content = log.records.map(record => JSON.stringify(replace(record))).join('\n')
    return log.trailingNewline ? `${content}\n` : content
  })
}
