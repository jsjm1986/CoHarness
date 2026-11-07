interface BaselineLink<T> {
  readonly value: T
  previous: BaselineLink<T> | undefined
  next: BaselineLink<T> | undefined
}

/**
 * Merge an authoritative baseline without moving identities already visible to
 * the client. Baseline-only identities are inserted relative to the nearest
 * following known identity; identities absent from the baseline are removed.
 *
 * @param current - the established client order.
 * @param baseline - the latest authoritative rows.
 * @param keyOf - stable identity selector.
 * @returns baseline-valued rows with the established relative order retained.
 */
export function mergeOrderedBaseline<T>(
  current: readonly T[],
  baseline: readonly T[],
  keyOf: (value: T) => unknown,
): T[] {
  const baselineByKey = new Map<unknown, T>()
  for (const value of baseline) baselineByKey.set(keyOf(value), value)
  const retained: T[] = []
  const links = new Map<unknown, BaselineLink<T> | undefined>()
  for (const value of current) {
    const key = keyOf(value)
    const replacement = baselineByKey.get(key)
    if (replacement === undefined) continue
    retained.push(replacement)
    links.set(key, undefined)
  }
  let hasNewIdentity = false
  for (const value of baseline) {
    if (value === undefined || links.has(keyOf(value))) continue
    hasNewIdentity = true
    break
  }
  if (!hasNewIdentity) return retained

  const incoming = baseline.map(value => ({ value, key: keyOf(value) }))
  const firstIndices = new Map<unknown, number>()
  for (const [index, row] of incoming.entries()) {
    if (!firstIndices.has(row.key)) firstIndices.set(row.key, index)
  }
  let head: BaselineLink<T> | undefined
  let tail: BaselineLink<T> | undefined
  const insert = (value: T, before?: BaselineLink<T>): BaselineLink<T> => {
    const previous = before === undefined ? tail : before.previous
    const link: BaselineLink<T> = { value, previous, next: before }
    if (previous === undefined) head = link
    else previous.next = link
    if (before === undefined) tail = link
    else before.previous = link
    return link
  }
  for (const value of retained) {
    const key = keyOf(value)
    const link = insert(value)
    if (links.get(key) === undefined) links.set(key, link)
  }

  // A following row can anchor an insertion only when its key is established
  // or first occurs earlier. A monotone stack finds that row for every key in
  // one backward pass, including repeated baseline keys.
  const priorities = incoming.map(row => links.has(row.key) ? -1 : firstIndices.get(row.key) as number)
  const anchors = new Array<number | undefined>(incoming.length)
  const following: number[] = []
  for (let index = incoming.length - 1; index >= 0; index--) {
    const row = incoming[index] as (typeof incoming)[number]
    if (row.value === undefined) continue
    const unmatchable = typeof row.key === 'number' && Number.isNaN(row.key)
    if (unmatchable && (links.has(row.key) || firstIndices.get(row.key) !== index)) continue
    const priority = priorities[index] as number
    while (following.length > 0 && (priorities[following.at(-1) as number] as number) >= priority) following.pop()
    anchors[index] = following.at(-1)
    // Map admission follows SameValueZero, while the matching anchor uses
    // strict key equality; NaN can be admitted but cannot anchor another row.
    if (!unmatchable) following.push(index)
  }
  for (const [index, row] of incoming.entries()) {
    if (row.value === undefined || links.has(row.key)) continue
    const anchor = anchors[index]
    const before = anchor === undefined ? undefined : links.get((incoming[anchor] as (typeof incoming)[number]).key)
    links.set(row.key, insert(row.value, before))
  }
  const merged: T[] = []
  for (let link = head; link !== undefined; link = link.next) {
    merged.push(link.value)
  }
  return merged
}
