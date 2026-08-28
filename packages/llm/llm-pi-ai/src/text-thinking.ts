/**
 * Incremental recognition of reasoning encoded in a text response.
 *
 * Some OpenAI-compatible gateways put a reasoning prefix in ordinary text,
 * for example `<thinking>...</thinking>answer`. Recognition is deliberately
 * narrow: the tag must be the first non-whitespace token, its closing tag must
 * arrive, and the body must contain non-whitespace text. Until those facts are
 * known, the parser withholds the prefix so an incomplete response remains
 * ordinary text instead of being irreversibly misclassified.
 *
 * @module dsh-llm-pi-ai/text-thinking
 */

/** Tags emitted by common OpenAI-compatible reasoning chat templates. */
export const TEXT_THINKING_TAGS = ['thinking', 'analysis', 'think'] as const

/**
 * One non-empty append-only part emitted by the parser. Reasoning is emitted
 * only after its close tag and is therefore always complete; answer text may
 * continue across later deltas.
 */
export type TextThinkingPart =
  | { type: 'reasoning'; text: string; complete: true }
  | { type: 'text'; text: string; complete: boolean }

/** The result of appending input or finalizing one parser. */
export interface TextThinkingUpdate {
  /** Newly available block content. */
  parts: readonly TextThinkingPart[]
  /** Whether this update recognized a valid tagged reasoning prefix. */
  transformed: boolean
}

type ParserMode = 'probe' | 'waiting-close' | 'plain' | 'transformed'

const OPENINGS = TEXT_THINKING_TAGS.map(tag => `<${tag}>`)

function isPrefixOfOpening(value: string): boolean {
  return OPENINGS.some(opening => opening.startsWith(value))
}

function openingAt(value: string): { tag: string; length: number } | undefined {
  for (const [index, opening] of OPENINGS.entries()) {
    const tag = TEXT_THINKING_TAGS[index]
    if (tag !== undefined && value.startsWith(opening)) return { tag, length: opening.length }
  }
  return undefined
}

/**
 * Parse one append-only text block for a strict tagged reasoning prefix.
 *
 * A valid prefix is converted only after its closing tag arrives. An
 * unclosed/opening-only response is emitted as text at {@link finish}, which
 * keeps truncated provider responses lossless.
 */
export class TextThinkingParser {
  /**
   * Retain source as append-only fragments. The parser may need the complete
   * spelling once, when a prefix is classified or finalized, but joining on
   * every provider delta would copy the already-seen response quadratically.
   */
  private readonly sourceParts: string[] = []
  private sourceLength = 0
  private sourceCache: string | undefined
  private emitted = 0
  private mode: ParserMode = 'probe'
  private tag: string | undefined
  private firstNonWhitespace: number | undefined
  /** Suffix retained to detect a close tag split across two deltas. */
  private closeTail = ''

  /** Whether this parser recognized and converted a valid tagged prefix. */
  get transformed(): boolean {
    return this.mode === 'transformed'
  }

  /** Whether the parser is withholding a prefix until it can classify it. */
  get pending(): boolean {
    return this.mode === 'probe' || this.mode === 'waiting-close'
  }

  /**
   * Append one provider text delta.
   * @param delta - the next text fragment in source order.
   * @returns content that is safe to expose as Harness blocks now.
   */
  append(delta: string): TextThinkingUpdate {
    if (delta.length === 0) return { parts: [], transformed: false }

    if (this.mode === 'plain') {
      this.pushSource(delta)
      this.emitted = this.sourceLength
      return { parts: [{ type: 'text', text: delta, complete: false }], transformed: false }
    }
    if (this.mode === 'transformed') {
      this.pushSource(delta)
      this.emitted = this.sourceLength
      return { parts: [{ type: 'text', text: delta, complete: false }], transformed: true }
    }

    const previousLength = this.sourceLength
    this.pushSource(delta)
    if (this.firstNonWhitespace === undefined) {
      const local = delta.search(/\S/u)
      if (local < 0) return { parts: [], transformed: false }
      this.firstNonWhitespace = previousLength + local
    }

    if (this.mode === 'probe') {
      const source = this.sourceText()
      const first = this.firstNonWhitespace
      const prefix = source.slice(first)
      const opening = openingAt(prefix)
      if (opening === undefined) {
        // Keep waiting when the current suffix is only a partial opening tag;
        // a split `<thinking>` must not be exposed as ordinary text.
        if (isPrefixOfOpening(prefix)) return { parts: [], transformed: false }
        this.mode = 'plain'
        return this.plainDelta()
      }
      this.mode = 'waiting-close'
      this.tag = opening.tag
      const close = `</${opening.tag}>`
      const openingEnd = first + opening.length
      const closeIndex = source.indexOf(close, openingEnd)
      if (closeIndex >= 0) return this.classify(source, first, openingEnd, closeIndex, close)
      this.closeTail = source.slice(Math.max(openingEnd, source.length - (close.length - 1)))
      return { parts: [], transformed: false }
    }

    const tag = this.tag
    /* v8 ignore next -- waiting-close is entered only after assigning the matched tag above. */
    if (tag === undefined) return { parts: [], transformed: false }
    const close = `</${tag}>`
    const closeIndex = (this.closeTail + delta).indexOf(close)
    if (closeIndex < 0) {
      this.closeTail = (this.closeTail + delta).slice(-(close.length - 1))
      return { parts: [], transformed: false }
    }
    const source = this.sourceText()
    const opening = `<${tag}>`
    const first = this.firstNonWhitespace
    const openingEnd = first + opening.length
    const globalCloseIndex = previousLength - this.closeTail.length + closeIndex
    return this.classify(source, first, openingEnd, globalCloseIndex, close)
  }

  /**
   * Finalize the text block at provider `text_end` or stream termination.
   *
   * A gateway may omit one or more deltas and provide the cumulative spelling
   * only on `text_end` (or the terminal assistant message). When that spelling
   * extends the deltas already seen, it is appended before classification. A
   * conflicting spelling cannot retract chunks already exposed, so the parser
   * keeps the prefix it already emitted.
   *
   * @param finalText - provider's cumulative text, when available.
   * @returns the remaining lossless text and the parser's final conversion.
   */
  finish(finalText?: string): TextThinkingUpdate {
    const parts: TextThinkingPart[] = []
    const source = this.sourceText()
    if (finalText !== undefined && finalText.length > this.sourceLength
      && finalText.startsWith(source)) {
      const update = this.append(finalText.slice(this.sourceLength))
      parts.push(...update.parts)
    }
    if (this.mode === 'transformed') {
      return { parts: parts.map(part => ({ ...part, complete: true })), transformed: true }
    }

    const tail = this.sourceText().slice(this.emitted)
    this.emitted = this.sourceLength
    if (tail.length > 0) parts.push({ type: 'text', text: tail, complete: true })
    this.mode = 'plain'
    return { parts: parts.map(part => ({ ...part, complete: true })), transformed: false }
  }

  private plainDelta(): TextThinkingUpdate {
    const text = this.sourceText().slice(this.emitted)
    this.emitted = this.sourceLength
    return { parts: [{ type: 'text', text, complete: false }], transformed: false }
  }

  /** Append one source fragment without copying previously received text. */
  private pushSource(delta: string): void {
    this.sourceParts.push(delta)
    this.sourceLength += delta.length
    this.sourceCache = undefined
  }

  /** Join source fragments only at a classification or finalization edge. */
  private sourceText(): string {
    return this.sourceCache ??= this.sourceParts.join('')
  }

  /**
   * Classify a complete close tag and emit the transformed reasoning prefix.
   * Empty bodies stay ordinary text, preserving XML-like provider output.
   */
  private classify(
    source: string,
    first: number,
    openingEnd: number,
    closeIndex: number,
    close: string,
  ): TextThinkingUpdate {
    const reasoningBody = source.slice(openingEnd, closeIndex)
    if (reasoningBody.trim().length === 0) {
      // Empty tagged prefixes are more likely formatting or an XML example
      // than model reasoning; preserve them verbatim.
      this.mode = 'plain'
      return this.plainDelta()
    }

    this.mode = 'transformed'
    // Keep leading formatting with the reasoning body. The two emitted blocks
    // preserve the provider's semantic content while the transport delimiters
    // themselves are intentionally removed.
    const reasoning = `${source.slice(0, first)}${reasoningBody}`
    const after = source.slice(closeIndex + close.length)
    this.emitted = this.sourceLength
    const parts: TextThinkingPart[] = [{ type: 'reasoning', text: reasoning, complete: true }]
    if (after.length > 0) parts.push({ type: 'text', text: after, complete: false })
    return { parts, transformed: true }
  }
}
