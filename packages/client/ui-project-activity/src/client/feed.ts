/** Activity feed wire types, account-route fetch, and client-side grouping. */

/** One member-visible feed row as served by `GET /account/api/activity`. */
export interface ActivityItem {
  readonly kind: 'message' | 'answer'
  readonly sessionId: string
  readonly conversationTitle: string | null
  readonly actorUserId: number
  readonly actorLabel: string
  readonly occurredAt: string
  readonly seq: number | null
  readonly text: string
  readonly questionText?: string
  readonly outcome?: unknown
}

/** Page of feed rows; `nextBefore` resumes after the last row when present. */
export interface ActivityPage {
  readonly items: readonly ActivityItem[]
  readonly nextBefore?: string
}

const PAGE_SIZE = 50

/**
 * Read one page of the project activity feed through the account session.
 * @param before - opaque cursor from the previous page.
 * @param signal - abort for superseded or disposed reads.
 * @returns the normalized page; transport and payload failures reject.
 */
export async function fetchActivity(before: string | undefined, signal: AbortSignal): Promise<ActivityPage> {
  const params = new URLSearchParams({ limit: String(PAGE_SIZE) })
  if (before !== undefined) params.set('before', before)
  const response = await fetch(`/account/api/activity?${params.toString()}`, { credentials: 'same-origin', signal })
  if (!response.ok) throw new Error(`project activity request failed: ${String(response.status)}`)
  const body = await response.json() as { items?: unknown; nextBefore?: unknown }
  if (!Array.isArray(body.items)) throw new TypeError('project activity returned an invalid page')
  return {
    items: body.items as readonly ActivityItem[],
    ...(typeof body.nextBefore === 'string' ? { nextBefore: body.nextBefore } : {}),
  }
}

/** Grouping modes offered by the panel toolbar. */
export type ActivityGrouping = 'time' | 'conversation' | 'member'

/** One rendered section: a header label plus its rows in feed order. */
export interface ActivitySection {
  readonly id: string
  readonly title: string
  readonly meta?: string
  /** Time mode only: the day header above this conversation section. */
  readonly day?: string
  readonly rows: readonly ActivityItem[]
}

/**
 * Render a timestamp as `HH:mm`.
 * @param iso - row `occurredAt` timestamp.
 * @returns local hours and minutes, zero-padded.
 */
export function timeLabel(iso: string): string {
  const date = new Date(iso)
  return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`
}

/**
 * Render a timestamp's local calendar day as `YYYY-MM-DD`.
 * @param iso - row `occurredAt` timestamp.
 * @returns local calendar date, zero-padded.
 */
export function dayLabel(iso: string): string {
  const date = new Date(iso)
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
}

/** Latest activity timestamp within a section's rows. */
function latestOf(rows: readonly ActivityItem[]): string {
  let latest = ''
  for (const row of rows) if (row.occurredAt > latest) latest = row.occurredAt
  return latest
}

/**
 * Group feed rows into sections. `time` nests day → conversation; `conversation`
 * and `member` produce one section per distinct key, ordered by latest activity.
 * @param items - feed rows in newest-first order.
 * @param grouping - active toolbar mode.
 * @param conversationTitle - fallback label for a null conversation title.
 * @returns ordered sections whose rows keep feed order.
 */
export function groupItems(
  items: readonly ActivityItem[],
  grouping: ActivityGrouping,
  conversationTitle: (sessionId: string) => string,
): ActivitySection[] {
  const titleOf = (item: ActivityItem): string => item.conversationTitle ?? conversationTitle(item.sessionId)
  if (grouping === 'time') {
    const days = new Map<string, Map<string, ActivityItem[]>>()
    const titles = new Map<string, string>()
    for (const item of items) {
      const day = dayLabel(item.occurredAt)
      let conversations = days.get(day)
      if (conversations === undefined) days.set(day, conversations = new Map<string, ActivityItem[]>())
      const key = `${titleOf(item)}${item.sessionId}`
      let rows = conversations.get(key)
      if (rows === undefined) conversations.set(key, rows = [])
      titles.set(key, titleOf(item))
      rows.push(item)
    }
    return [...days.entries()].flatMap(([day, conversations]) =>
      [...conversations.entries()].map(([key, rows]) => ({
        id: `${day}/${key}`, day, title: titles.get(key) ?? '', meta: String(rows.length), rows,
      })))
  }
  const keyed = new Map<string, ActivityItem[]>()
  for (const item of items) {
    const key = grouping === 'conversation' ? `${titleOf(item)}${item.sessionId}` : `${item.actorLabel}${item.actorUserId}`
    let rows = keyed.get(key)
    if (rows === undefined) keyed.set(key, rows = [])
    rows.push(item)
  }
  return [...keyed.entries()]
    .sort((left, right) => latestOf(right[1]).localeCompare(latestOf(left[1])))
    .map(([key, rows]) => {
      const first = rows[0]
      if (first === undefined) return { id: key, title: '', rows }
      return {
        id: key,
        title: grouping === 'conversation' ? titleOf(first) : first.actorLabel,
        meta: timeLabel(latestOf(rows)),
        rows,
      }
    })
}

/**
 * Distinct members present in the feed, for the member filter menu.
 * @param items Feed rows to scan.
 * @returns First-seen member identities in feed order.
 */
export function feedMembers(items: readonly ActivityItem[]): readonly { userId: number; label: string }[] {
  const seen = new Map<number, string>()
  for (const item of items) if (!seen.has(item.actorUserId)) seen.set(item.actorUserId, item.actorLabel)
  return [...seen.entries()].map(([userId, label]) => ({ userId, label }))
}
