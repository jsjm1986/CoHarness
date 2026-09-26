/** Price surface attachments by the image and file representations sent to the model. */

import type { ContentBlock, LlmImageRequestPricing } from '@deepseek-ai/dsh-llm'
import { estimateContent } from './estimate.ts'
import { surfaceAttachmentFacts } from './surface-fold.ts'
import type { TokenSurfaceNode } from './types.ts'

type FileAttachmentRef = Extract<ContentBlock, { type: 'file' }>['attachment']

/**
 * Price a detached surface under its model-request attachment projection.
 * @param nodes - heuristic surface nodes to detach and reprice.
 * @param pricing - route-owned image pricing, when the current route declares one.
 * @param fileText - current file-handle text produced by the mounted LLM service.
 * @returns detached nodes and their repriced surface total.
 */
export function priceSurface(
  nodes: readonly TokenSurfaceNode[],
  pricing: LlmImageRequestPricing | undefined,
  fileText?: (ref: FileAttachmentRef) => string,
): { nodes: TokenSurfaceNode[]; surfaceTokens: number } {
  const facts = nodes.map(node => surfaceAttachmentFacts(node))
  const images = pricing === undefined ? [] : facts.flatMap(value => value?.images ?? [])
  const hasFiles = fileText !== undefined && facts.some(value => value !== undefined && value.files.length > 0)
  if (images.length === 0 && !hasFiles) {
    let surfaceTokens = 0
    const detached = nodes.map((node) => {
      surfaceTokens += node.tokens
      return { seq: node.seq, tokens: node.tokens, heuristicTokens: node.tokens }
    })
    return { nodes: detached, surfaceTokens }
  }
  const prices = pricing === undefined ? [] : pricing.priceImages(images)
  if (prices.length !== images.length) {
    throw new Error(`token meter: route image pricing answered ${prices.length} prices for ${images.length} occurrences`)
  }
  let cursor = 0
  let surfaceTokens = 0
  const detached = nodes.map((node, index) => {
    const nodeFacts = facts[index]
    let tokens = node.tokens
    if (fileText !== undefined && nodeFacts !== undefined && nodeFacts.files.length > 0) {
      tokens -= nodeFacts.fileStructuralTokens
      for (const file of nodeFacts.files) tokens += estimateContent([{ type: 'text', text: fileText(file) }])
    }
    if (pricing !== undefined && nodeFacts !== undefined && nodeFacts.images.length > 0) {
      tokens -= nodeFacts.imageStructuralTokens
      for (const _image of nodeFacts.images) {
        const price = prices[cursor]
        cursor += 1
        if (price === undefined || !Number.isSafeInteger(price.visualTokens) || price.visualTokens < 0) {
          throw new Error('token meter: route image pricing returned an invalid visual token count')
        }
        tokens += price.visualTokens + estimateContent([{ type: 'text', text: price.text }])
      }
    }
    surfaceTokens += tokens
    return { seq: node.seq, tokens, heuristicTokens: node.tokens }
  })
  return { nodes: detached, surfaceTokens }
}
