/** Shared narrowing for raw Tool result fields consumed by tool views. */
import type { ToolResultNode } from '@deepseek-ai/dsh-client-runtime/client'

/**
 * Read the only text block from a settled result.
 *
 * A result with mixed content must stay on the generic renderer: selecting
 * only its text blocks would hide diagnostic blocks from the expanded output.
 * @param block - Settled tool result from the conversation projection.
 * @returns The text when the result contains exactly one text block; otherwise undefined.
 */
export function singleResultText(block: ToolResultNode): string | undefined {
  if (block.content.length !== 1) return undefined
  const only = block.content[0]
  return only?.type === 'text' ? only.text : undefined
}
