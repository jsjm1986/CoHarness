/** Route-aware image pricing for token-meter surface snapshots. */

import type { LlmImageRequestPricing } from '@deepseek-ai/dsh-llm'
import { estimateContent } from './estimate.ts'
import { surfaceImageFacts } from './surface-fold.ts'
import type { TokenSurfaceNode } from './types.ts'

/**
 * Price a detached surface under an adapter-declared image formula.
 * @param nodes - heuristic surface nodes to detach and reprice.
 * @param pricing - route-owned image pricing, when the current route declares one.
 * @returns detached nodes and their repriced surface total.
 */
export function priceSurface(
  nodes: readonly TokenSurfaceNode[],
  pricing: LlmImageRequestPricing | undefined,
): { nodes: TokenSurfaceNode[]; surfaceTokens: number } {
  const facts = nodes.map(node => surfaceImageFacts(node))
  const images = facts.flatMap(value => value?.images ?? [])
  if (pricing === undefined || images.length === 0) {
    let surfaceTokens = 0
    const detached = nodes.map((node) => {
      surfaceTokens += node.tokens
      return { seq: node.seq, tokens: node.tokens }
    })
    return { nodes: detached, surfaceTokens }
  }
  const prices = pricing.priceImages(images)
  if (prices.length !== images.length) {
    throw new Error(`token meter: route image pricing answered ${prices.length} prices for ${images.length} occurrences`)
  }
  let cursor = 0
  let surfaceTokens = 0
  const detached = nodes.map((node, index) => {
    const nodeFacts = facts[index]
    let tokens = node.tokens
    if (nodeFacts !== undefined) {
      tokens = nodeFacts.imageFreeTokens
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
