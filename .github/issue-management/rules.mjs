/** Pure Issue/PR validation, repository identity, lifecycle decisions, and Project dates. */

import process from 'node:process'

import config from './config.json' with { type: 'json' }

const BODY_LIMIT = 50
const OWNER_LINE = /^Owner: @([A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?)$/
const TYPES = new Set(['Idea', 'Feature', 'Bug', 'Research', 'Task'])
const PRIORITIES = ['p0', 'p1', 'p2', 'p3']
const PROJECT_OWNER_TYPES = new Set(['organization', 'user'])
const PR_KINDS = new Set([
  'kind/feature',
  'kind/bug-fix',
  'kind/doc',
  'kind/testing',
  'kind/cleanup',
  'kind/dependency',
])
// Retired label aliases stay reserved so they cannot be recreated.
const LEGACY_LABELS = new Set([
  'kind/bug',
  'kind/documentation',
  'feature',
  'bug-fix',
  'doc',
  'cleanup',
  'testing',
  'dependencies',
  'ci',
  'cli',
  'llm',
  'web-search',
])
const TERMINAL_STATUSES = new Set(['Done', 'No action'])
const ACTIVE_STATUS_ORDER = config.statuses.filter((status) => !TERMINAL_STATUSES.has(status))
const IMPLEMENTATION_PULL_REQUEST_ACTIONS = new Set([
  'opened',
  'edited',
  'reopened',
])

/**
 * Return the configured canonical repository.
 * @returns {string} GitHub owner/name.
 */
export function canonicalRepository() {
  return config.canonicalRepository ?? `${config.repositoryOwner}/${config.repository}`
}

/**
 * Resolve which GitHub account field owns the configured Project.
 * @param {string} ownerType Configured Project owner type.
 * @returns {{organization: boolean, user: boolean}} GraphQL include flags.
 */
export function projectOwnerSelection(ownerType = config.projectOwnerType) {
  if (!PROJECT_OWNER_TYPES.has(ownerType)) {
    throw new Error(`config.projectOwnerType 必须是 organization 或 user，当前为 ${String(ownerType)}`)
  }
  return {
    organization: ownerType === 'organization',
    user: ownerType === 'user',
  }
}

const PROJECT_OWNER_SELECTION = projectOwnerSelection()

/**
 * Verify that a policy run targets the repository owning its Project.
 * @param {{runtimeRepository?: string, eventRepository?: string, expectedRepository?: string}} input Repository identities.
 * @returns {void}
 */
export function assertCanonicalRepository({
  runtimeRepository = process.env.GITHUB_REPOSITORY,
  eventRepository,
  expectedRepository = canonicalRepository(),
} = {}) {
  const actual = runtimeRepository ?? eventRepository
  if (!actual) throw new Error('GITHUB_REPOSITORY 未设置，无法确认 Issue policy 目标仓库')
  if (eventRepository && eventRepository.toLowerCase() !== actual.toLowerCase()) {
    throw new Error(`Issue policy 运行仓库与事件仓库不一致：${actual} != ${eventRepository}`)
  }
  if (actual.toLowerCase() !== expectedRepository.toLowerCase()) {
    throw new Error(`Issue policy 仅允许在 ${expectedRepository} 运行，当前仓库为 ${actual}`)
  }
}

for (const status of ['In progress', 'In review']) {
  if (!ACTIVE_STATUS_ORDER.includes(status)) throw new Error(`config.statuses 缺少 ${status}`)
}
if (typeof config.lifecycleActor !== 'string' || !config.lifecycleActor) {
  throw new Error('config.lifecycleActor 未设置')
}
if (typeof config.priorityField !== 'string' || !config.priorityField) {
  throw new Error('config.priorityField 未设置')
}
if (typeof config.startDateField !== 'string' || !config.startDateField) {
  throw new Error('config.startDateField 未设置')
}
if (typeof config.projectTimeZone !== 'string' || !config.projectTimeZone) {
  throw new Error('config.projectTimeZone 未设置')
}
Intl.DateTimeFormat('en-US', { timeZone: config.projectTimeZone })

/**
 * Return Markdown outside balanced details elements.
 * @param {string} body Markdown body.
 * @returns {{text: string, balanced: boolean, detailsCount: number, allCollapsed: boolean}} Visible source and details shape.
 */
export function extractOutsideDetails(body) {
  const source = body.replace(/<!--[\s\S]*?-->/g, '')
  const tag = /<\/?details\b[^>]*>/gi
  let depth = 0
  let cursor = 0
  let balanced = true
  let text = ''
  let detailsCount = 0
  let allCollapsed = true

  for (const match of source.matchAll(tag)) {
    const index = match.index ?? 0
    if (depth === 0) text += source.slice(cursor, index)
    if (/^<\//.test(match[0])) {
      if (depth === 0) balanced = false
      else depth -= 1
    } else {
      depth += 1
      detailsCount += 1
      if (/\sopen(?:\s|=|>)/i.test(match[0])) allCollapsed = false
    }
    cursor = index + match[0].length
  }

  if (depth === 0) text += source.slice(cursor)
  if (depth !== 0) balanced = false
  return { text, balanced, detailsCount, allCollapsed }
}

/**
 * Count Chinese characters and contiguous Latin, numeric, or code tokens.
 * @param {string} body Markdown body.
 * @returns {{units: number, balanced: boolean, detailsCount: number, allCollapsed: boolean}} Visible unit count and details shape.
 */
export function countVisibleUnits(body) {
  const outside = extractOutsideDetails(body)
  const visible = outside.text
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]+)\]\[[^\]]*\]/g, '$1')
    .replace(/<((?:https?:\/\/|mailto:)[^>]+)>/gi, '$1')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&(?:[A-Za-z]+|#\d+|#x[0-9A-Fa-f]+);/g, ' ')
    .replace(/[\u0060*~\[\]{}()<>#!|]/g, ' ')
  const han = visible.match(/\p{Script=Han}/gu)?.length ?? 0
  const tokens = visible.match(/[\p{Script=Latin}\p{Number}_./:@+-]+/gu)?.length ?? 0
  return {
    units: han + tokens,
    balanced: outside.balanced,
    detailsCount: outside.detailsCount,
    allCollapsed: outside.allCollapsed,
  }
}

function firstNonblankLine(body) {
  return body
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find(Boolean)
}

/**
 * Validate required body sections and check Owner against assignees.
 * @param {{body: string, assignees: string[], allowUnassignedOwner?: boolean}} input Body input.
 * @returns {string[]} Validation errors.
 */
export function validateBody({
  body,
  assignees,
  allowUnassignedOwner = config.allowUnassignedOwner ?? false,
}) {
  const errors = []
  const count = countVisibleUnits(body)
  const owner = firstNonblankLine(body)?.match(OWNER_LINE)?.[1] ?? null
  const normalized = [...new Set(assignees.map((login) => login.toLowerCase()))]

  if (!count.balanced) errors.push('details 标签必须成对闭合')
  if (count.detailsCount === 0) errors.push('正文必须包含默认收起的 <details> 区域')
  if (!count.allCollapsed) errors.push('details 必须默认收起，不得设置 open')
  if (count.units > BODY_LIMIT) {
    errors.push(`正文外露部分为 ${count.units} 单位，超过 50 单位`)
  }
  if (normalized.length >= 2 && !owner) {
    errors.push('多个 Assignees 时首个非空行必须是 Owner: @login')
  } else if (normalized.length >= 2 && !normalized.includes(owner.toLowerCase())) {
    errors.push('Owner 必须属于 Assignees')
  } else if (
    normalized.length < 2 &&
    owner &&
    !(normalized.length === 0 && allowUnassignedOwner)
  ) {
    errors.push('零或一个 Assignee 时不得写 Owner 行')
  }
  return errors
}

/**
 * Decide whether the human-review policy applies to a PR.
 * @param {{isDraft: boolean, authorType: string, reviewRequestCount: number, reviewCount: number}} input PR state.
 * @returns {boolean} Whether the PR policy is mandatory.
 */
export function requiresPullRequestPolicy({
  isDraft,
  authorType,
  reviewRequestCount,
  reviewCount,
}) {
  const automated = authorType === 'Bot' || authorType === 'App'
  return !isDraft && !automated && (reviewRequestCount > 0 || reviewCount > 0)
}

/**
 * Translate a repository event into one resolving-Issue lifecycle command.
 * @param {string} eventName GitHub event name.
 * @param {{action?: string, changes?: {body?: object}, review?: {state?: string}}} event GitHub event payload.
 * @returns {'implementation'|'review-requested'|'changes-requested'|null} Lifecycle command.
 */
export function resolvingIssueStatusCommand(eventName, event) {
  if (eventName === 'pull_request') {
    if (event.action === 'edited' && !event.changes?.body) return null
    if (event.action === 'review_requested') return 'review-requested'
    return IMPLEMENTATION_PULL_REQUEST_ACTIONS.has(event.action) ? 'implementation' : null
  }
  if (
    eventName === 'pull_request_review' &&
    event.action === 'submitted' &&
    event.review?.state?.toLowerCase() === 'changes_requested'
  ) {
    return 'changes-requested'
  }
  return null
}

/**
 * Plan one event-directed resolving-Issue status transition.
 * @param {string|null} currentStatus Current Project status.
 * @param {'implementation'|'review-requested'|'changes-requested'} command Lifecycle command.
 * @param {string|null} currentStatusActor Actor that last set the current Project status.
 * @returns {string|null} Status to write, or null when no permitted transition exists.
 */
export function nextResolvingIssueStatus(currentStatus, command, currentStatusActor = null) {
  let target
  if (command === 'review-requested') target = 'In review'
  else if (command === 'implementation' || command === 'changes-requested') target = 'In progress'
  else throw new Error(`未知 lifecycle command：${command}`)

  const currentIndex = ACTIVE_STATUS_ORDER.indexOf(currentStatus)
  const targetIndex = ACTIVE_STATUS_ORDER.indexOf(target)
  if (
    command === 'changes-requested' &&
    currentStatus === 'In review' &&
    currentStatusActor === config.lifecycleActor
  ) {
    return target
  }
  return currentIndex >= 0 && currentIndex < targetIndex ? target : null
}

/**
 * Convert a GitHub timestamp to a Project date in one configured time zone.
 * @param {string} timestamp ISO timestamp.
 * @param {string} timeZone IANA time-zone name.
 * @returns {string} Calendar date in YYYY-MM-DD form.
 */
export function projectDate(timestamp, timeZone = config.projectTimeZone) {
  const instant = new Date(timestamp)
  if (Number.isNaN(instant.getTime())) throw new Error(`无效的 PR 创建时间：${timestamp}`)
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    })
      .formatToParts(instant)
      .filter((part) => part.type !== 'literal')
      .map((part) => [part.type, part.value]),
  )
  return `${parts.year}-${parts.month}-${parts.day}`
}

function stripIgnoredMarkdown(body) {
  const lines = body.replace(/<!--[\s\S]*?-->/g, '').split(/\r?\n/)
  const kept = []
  let fence = null
  for (const line of lines) {
    const marker = line.match(/^\s*([\u0060~]{3,})/)
    if (marker) {
      if (fence === null) fence = marker[1][0]
      else if (marker[1][0] === fence) fence = null
      continue
    }
    if (fence === null) kept.push(line)
  }
  return kept.join('\n').replace(/\u0060[^\u0060]*\u0060/g, ' ')
}

/**
 * Parse same-repository resolving and informational references.
 * @param {{body: string, repository: string}} input PR body and repository.
 * @returns {{all: number[], resolving: number[], related: number[]}} References.
 */
export function parseReferences({ body, repository }) {
  const source = stripIgnoredMarkdown(body)
  const expected = repository.toLowerCase()
  const all = new Set()
  const resolving = new Set()
  const reference =
    /(?:([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)#|#)(\d+)|https:\/\/github\.com\/([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)\/issues\/(\d+)/gi
  const closing =
    /\b(?:close(?:s|d)?|fix(?:es|ed)?|resolve(?:s|d)?)\s*:?\s+(?:(?:([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)#|#)(\d+)|https:\/\/github\.com\/([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)\/issues\/(\d+))/gi

  for (const match of source.matchAll(reference)) {
    const explicit = (match[1] ?? match[3] ?? '').toLowerCase()
    const number = Number(match[2] ?? match[4])
    if (!explicit || explicit === expected) all.add(number)
  }
  for (const match of source.matchAll(closing)) {
    const explicit = (match[1] ?? match[3] ?? '').toLowerCase()
    const number = Number(match[2] ?? match[4])
    if (!explicit || explicit === expected) {
      all.add(number)
      resolving.add(number)
    }
  }
  return {
    all: [...all].sort((left, right) => left - right),
    resolving: [...resolving].sort((left, right) => left - right),
    related: [...all].filter((number) => !resolving.has(number)).sort((a, b) => a - b),
  }
}

/**
 * Retain only references that resolve to Issues rather than pull requests.
 * @param {{all: number[], resolving: number[], related: number[]}} references Parsed references.
 * @param {Map<number, unknown>} issues Resolved same-repository Issues.
 * @returns {{all: number[], resolving: number[], related: number[]}} Issue-only references.
 */
export function retainIssueReferences(references, issues) {
  return {
    all: references.all.filter((number) => issues.has(number)),
    resolving: references.resolving.filter((number) => issues.has(number)),
    related: references.related.filter((number) => issues.has(number)),
  }
}

/**
 * Validate one Issue with its Project status.
 * @param {{title: string, body: string, assignees: string[], labels: string[], type: string|null, priority: string|null, status: string|null, state: string, stateReason: string|null}} issue Issue snapshot.
 * @returns {string[]} Validation errors.
 */
export function validateIssue(issue) {
  const errors = validateBody(issue)
  const status = issue.status
  const invalidLabels = issue.labels.filter(isInvalidIssueLabel)

  if (!/\p{Script=Han}/u.test(issue.title)) errors.push('Issue 标题必须包含中文')
  if (invalidLabels.length > 0) {
    errors.push(`Issue 不得使用 PR kind 或旧版标签：${invalidLabels.join(', ')}`)
  }
  if (
    /^\s*(?:\[(?:Idea|Feature|Bug|Research|Task|P[0-3]|Inbox|Backlog|Ready|In progress|In review|Done|No action|Owner|area\/[^\]]+)[^\]]*\]|(?:Idea|Feature|Bug|Research|Task|P[0-3]|Inbox|Backlog|Ready|In progress|In review|Done|No action|Owner|area\/[^:： ]+)\s*[:：-])/iu.test(
      issue.title,
    )
  ) {
    errors.push('Issue 标题不得带 Type、Priority、Status、area 或 Owner 前缀')
  }
  if (!TYPES.has(issue.type ?? '')) errors.push('Type 必须是五种原生英文 Type 之一')
  if (!status || !config.statuses.includes(status)) errors.push('Issue 必须在 Project 中且具有合法 Status')
  if (issue.priority !== null && !PRIORITIES.includes(issue.priority.toLowerCase())) {
    errors.push('Priority 必须为空或为 P0–P3')
  }
  if (status === 'Done' && (issue.state !== 'closed' || issue.stateReason !== 'completed')) {
    errors.push('Done 必须对应 Completed 关闭原因')
  }
  if (
    status === 'No action' &&
    (issue.state !== 'closed' || issue.stateReason !== 'not_planned')
  ) {
    errors.push('No action 必须对应 Not planned 关闭原因')
  }
  if (!['Done', 'No action'].includes(status ?? '') && issue.state !== 'open') {
    errors.push(`${status} 必须对应开放 Issue`)
  }
  return errors
}

/**
 * Identify PR kinds and retired aliases that cannot label an Issue.
 * @param {string} label Label name.
 * @returns {boolean} Whether the label is invalid for Issues.
 */
export function isInvalidIssueLabel(label) {
  return label.startsWith('kind/') || LEGACY_LABELS.has(label)
}

/**
 * Validate PR metadata and its referenced Issues.
 * @param {{authorType: string, labels: string[], references: ReturnType<typeof parseReferences>, issues: Map<number, {priority: string|null}>}} input PR snapshot.
 * @returns {string[]} Validation errors.
 */
export function validatePullRequest(input) {
  if (!requiresPullRequestPolicy(input)) return []
  const errors = []
  const kinds = input.labels.filter((label) => PR_KINDS.has(label))
  const unknownKinds = input.labels.filter(
    (label) => label.startsWith('kind/') && !PR_KINDS.has(label) && !LEGACY_LABELS.has(label),
  )
  const legacyLabels = input.labels.filter((label) => LEGACY_LABELS.has(label))
  const sourceLabels = input.labels.filter((label) => label.startsWith('source/'))
  const priorities = input.labels.filter((label) => PRIORITIES.includes(label))
  const areas = input.labels.filter((label) => label.startsWith('area/'))

  if (input.references.all.length === 0) {
    errors.push('PR 正文必须引用至少一个同仓库 Issue；PR 编号（包括堆叠依赖 PR）不算 Issue 引用')
  }
  if (kinds.length !== 1) {
    errors.push(`PR 必须恰好有一个允许的 kind/*，当前为 ${kinds.length}`)
  }
  if (unknownKinds.length > 0) {
    errors.push(`PR 含不支持的 kind/*：${unknownKinds.join(', ')}`)
  }
  if (legacyLabels.length > 0) errors.push(`PR 含旧版标签：${legacyLabels.join(', ')}`)
  if (sourceLabels.length > 0) errors.push(`source/* 仅用于 Issue：${sourceLabels.join(', ')}`)
  if (priorities.length > 1) errors.push(`PR 最多有一个 p0–p3，当前为 ${priorities.length}`)
  if (areas.length === 0) errors.push('PR 必须至少有一个 area/*')
  for (const number of input.references.all) {
    if (!input.issues.has(number)) errors.push(`#${number} 不是同仓库 Issue`)
  }

  const resolving = input.references.resolving
    .map((number) => [number, input.issues.get(number)])
    .filter((entry) => entry[1])
  if (resolving.length === 0) return errors

  const issuePriorities = resolving
    .map(([, issue]) => issue.priority?.toLowerCase())
    .filter((priority) => PRIORITIES.includes(priority))
  if (priorities.length === 0 && issuePriorities.length > 0) {
    const highest = issuePriorities.sort(
      (left, right) => PRIORITIES.indexOf(left) - PRIORITIES.indexOf(right),
    )[0]
    errors.push(`PR Priority 应为 ${highest}`)
  } else if (priorities.length === 1 && issuePriorities.length !== resolving.length) {
    errors.push('有 Priority 的解决型 PR 要求每个被解决 Issue 都设置 Priority')
  } else if (priorities.length === 1) {
    const highest = issuePriorities.sort(
      (left, right) => PRIORITIES.indexOf(left) - PRIORITIES.indexOf(right),
    )[0]
    if (priorities[0] !== highest) errors.push(`PR Priority 应为 ${highest}`)
  }
  return errors
}

export { PROJECT_OWNER_SELECTION }
