/**
 * The measurement service's positional surface fold: the per-node priced
 * surface `measure()` serves and compaction plans against. The projection
 * units deliberately do NOT share this fold — their state must stay O(1)
 * for the persisted checkpoint, so they ride `surface-projection.ts`'s
 * shadow-price protocol instead. Fully metered logs stay in agreement by
 * construction: both price through `estimate.ts`, and every logged shadow
 * price is derived from THIS fold's nodes by the replace producer. A
 * projection replacement without a claim deliberately folds with zero delta.
 *
 * @module @deepseek-ai/dsh-token-meter/surface-fold
 */

import { deriveEventMessage, validateSurfaceMetadata } from '@deepseek-ai/dsh-session'
import type { SessionSeq, SurfaceEvent } from '@deepseek-ai/dsh-session'
import type { ContentBlock, ImageBlock, Message } from '@deepseek-ai/dsh-llm'
import type { TokenSurfaceNode } from './types.ts'
import { estimateMessage, estimateStructuralBlock } from './estimate.ts'

type FileAttachmentRef = Extract<ContentBlock, { type: 'file' }>['attachment']

/** Attachment occurrences and their structural prices retained beside a heuristic node. */
export interface SurfaceAttachmentFacts {
  readonly images: readonly ImageBlock[]
  readonly imageStructuralTokens: number
  readonly files: readonly FileAttachmentRef[]
  readonly fileStructuralTokens: number
}

const attachmentFacts = new WeakMap<object, SurfaceAttachmentFacts>()

/**
 * Read route-pricing metadata for one node created by this fold.
 * @param node - surface node produced by {@link foldSurfaceTokens}.
 * @returns attachment facts retained for request pricing, or `undefined` for text-only nodes.
 */
export function surfaceAttachmentFacts(node: TokenSurfaceNode): SurfaceAttachmentFacts | undefined {
  return attachmentFacts.get(node)
}

function collectAttachments(blocks: readonly ContentBlock[]): SurfaceAttachmentFacts {
  const images: ImageBlock[] = []
  const files: FileAttachmentRef[] = []
  let imageStructuralTokens = 0
  let fileStructuralTokens = 0
  for (const block of blocks) {
    if (block.type === 'image') {
      images.push(block)
      imageStructuralTokens += estimateStructuralBlock(block)
    } else if (block.type === 'file') {
      files.push(block.attachment)
      fileStructuralTokens += estimateStructuralBlock(block)
    } else if (block.type === 'tool-result') {
      const nested = collectAttachments(block.content)
      images.push(...nested.images)
      files.push(...nested.files)
      imageStructuralTokens += nested.imageStructuralTokens
      fileStructuralTokens += nested.fileStructuralTokens
    }
  }
  return { images, imageStructuralTokens, files, fileStructuralTokens }
}

function makeNode(seq: SessionSeq, message: Message | null, tokens: number): TokenSurfaceNode {
  const node: TokenSurfaceNode = { seq, tokens, heuristicTokens: tokens }
  if (message !== null) {
    const facts = collectAttachments(message.content)
    if (facts.images.length > 0 || facts.files.length > 0) attachmentFacts.set(node, facts)
  }
  return node
}

/** One surface event's placement and cost against the surface preceding it. */
export interface SurfaceTokenFold {
  /** Heuristic price of the event's own message; 0 when it derives none. */
  readonly tokens: number
  /** The surface after the event, detached from the input. */
  readonly nodes: TokenSurfaceNode[]
  /** Signed change in the surface total: `tokens` minus anything shadowed. */
  readonly deltaTokens: number
}

/**
 * Fold one surface event onto a priced surface.
 *
 * Total and allocation-fresh: the caller assigns the result rather than
 * mutating in place, so a throw here leaves the caller's state untouched and
 * the same malformed event fails identically on every retry.
 * @param nodes - the priced surface preceding this event, in model-visible order.
 * @param event - the surface event to place.
 * @param messageOverride - optional message used instead of the event's durable message.
 * @returns the event's price, the next surface, and the signed total delta.
 * @throws when a replacement names a range absent from `nodes` — committed
 *   logs are surface-validated at append time, so an unresolvable range is log
 *   corruption and must fail loud rather than skip the event.
 */
export function foldSurfaceTokens(
  nodes: readonly TokenSurfaceNode[],
  event: SurfaceEvent,
  messageOverride?: Message | null,
): SurfaceTokenFold {
  const message = messageOverride === undefined ? deriveEventMessage(event) : messageOverride
  const tokens = message === null ? 0 : estimateMessage(message)
  // Committed pre-rename logs still carry `start`/`end`; validateSurfaceMetadata
  // normalizes both spellings into the canonical op.
  const op = validateSurfaceMetadata(event)
  if (op === 'append') {
    return { tokens, nodes: [...nodes, makeNode(event.seq, message, tokens)], deltaTokens: tokens }
  }
  if (op === undefined) {
    throw new Error(`token surface: event at seq ${event.seq} carries no surface operation`)
  }
  const startIdx = nodes.findIndex(node => node.seq === op.startSeq)
  const endIdx = nodes.findIndex(node => node.seq === op.endSeq)
  if (startIdx === -1 || endIdx === -1 || startIdx > endIdx) {
    throw new Error(
      `token surface: replace at seq ${event.seq} has invalid current range ${op.startSeq}-${op.endSeq}`,
    )
  }
  const removed = nodes
    .slice(startIdx, endIdx + 1)
    .reduce((total, node) => total + node.tokens, 0)
  const next = [...nodes]
  next.splice(startIdx, endIdx - startIdx + 1, makeNode(event.seq, message, tokens))
  return { tokens, nodes: next, deltaTokens: tokens - removed }
}
