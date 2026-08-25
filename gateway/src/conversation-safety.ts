/** Durable conversation safety checks for model-produced text. */

const TAG_NAMES = ['thinking', 'analysis', 'think'] as const

type PrefixStatus = 'plain' | 'pending' | 'tagged'

function firstNonWhitespace(value: string): number {
  const index = value.search(/\S/u)
  return index < 0 ? value.length : index
}

function openingTag(value: string): { name: string; end: number } | undefined {
  const first = firstNonWhitespace(value)
  const candidate = value.slice(first)
  const match = candidate.match(/^<(thinking|analysis|think)(?:\s[^>]*)?>/iu)
  if (match === null || match[1] === undefined) return undefined
  return { name: match[1].toLowerCase(), end: first + match[0].length }
}

function possibleOpening(value: string): boolean {
  const first = firstNonWhitespace(value)
  if (first === value.length) return false
  const candidate = value.slice(first).toLowerCase()
  return TAG_NAMES.some(tag => {
    const prefix = `<${tag}`
    return prefix.startsWith(candidate) || candidate.startsWith(prefix)
  })
}

function prefixStatus(value: string): PrefixStatus {
  const first = firstNonWhitespace(value)
  if (first === value.length) return 'plain'
  const candidate = value.slice(first)
  const opening = openingTag(value)
  if (opening === undefined) return possibleOpening(value) ? 'pending' : 'plain'
  const close = new RegExp(`</${opening.name}\\s*>`, 'iu')
  return close.test(candidate.slice(opening.end - first)) ? 'tagged' : 'pending'
}

/** Return whether text starts with a tagged or incomplete thinking prefix. */
export function hasTaggedThinkingPrefix(text: string): boolean {
  return prefixStatus(text) !== 'plain'
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
}

function contentHasTaggedThinking(value: unknown): boolean {
  if (!Array.isArray(value)) return false
  return value.some(blockValue => {
    const block = record(blockValue)
    if (block === undefined) return false
    if (block.type === 'text' && typeof block.text === 'string') return hasTaggedThinkingPrefix(block.text)
    return block.type === 'tool-result' && contentHasTaggedThinking(block.content)
  })
}

/** Reject one durable assistant event that still carries tagged thinking as text. */
export function assertSafeAssistantEvent(event: { type: string; data: unknown }): void {
  if (event.type === 'assistant/message') {
    const data = record(event.data)
    const message = record(data?.message)
    if (contentHasTaggedThinking(message?.content)) {
      throw new Error('assistant message contains unnormalized tagged thinking text')
    }
    return
  }
  if (event.type === 'assistant/chunk') {
    const data = record(event.data)
    const chunk = record(data?.chunk)
    const block = record(chunk?.block)
    if (chunk?.type === 'block-end' && block?.type === 'text' && typeof block.text === 'string'
      && hasTaggedThinkingPrefix(block.text)) {
      throw new Error('assistant chunk contains unnormalized tagged thinking text')
    }
  }
}
