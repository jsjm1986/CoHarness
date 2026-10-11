/** Resolve a tool-details tab's chip presentation from the Session's loaded window. */
import type { ConversationSnapshot, ToolCallBlock } from '@deepseek-ai/dsh-client-runtime/client'

/** What the chip shows: the call's wire name and the card kind its body renders. */
export interface ToolCallPresentation {
  /** The wire name the details body titles itself with. */
  readonly name: string
  /** The render intent of the call's card, or `undefined` for the generic body. */
  readonly card: string | undefined
}

/**
 * The presentation of one call. A settled call shows what its RESULT draws —
 * search, read, web, diff, terminal, or the generic JSON body — falling back
 * to the call's own intent while the result is out of window; a running call
 * announces only its call intent.
 * @param block - running or settled call.
 * @returns wire name plus card kind.
 */
function presentationOf(block: ToolCallBlock): ToolCallPresentation {
  if ('kind' in block) {
    return {
      name: block.call?.name ?? block.callId,
      card: block.resultView?.card === 'generic' ? undefined
        : (block.resultView?.card ?? (block.callView?.card === 'generic' ? undefined : block.callView?.card)),
    }
  }
  return { name: block.name, card: block.callView?.card === 'generic' ? undefined : block.callView?.card }
}

/**
 * Depth-first over a call's own subtree: the tab may address a nested
 * run_code dispatch, so a match is not only a root.
 */
function visit(block: ToolCallBlock, callId: string): ToolCallPresentation | undefined {
  if (block.callId === callId) return presentationOf(block)
  for (const child of block.subCalls) {
    const found = visit(child, callId)
    if (found !== undefined) return found
  }
  return undefined
}

/**
 * The tool-details chip's presentation while the call's lifecycle is in the
 * loaded window, `undefined` when it is not. Calls still in flight live on
 * `runningCalls`; settled ones are the tool-result surface nodes.
 * @param snapshot - the owning Session's conversation snapshot.
 * @param callId - the call the tab addresses.
 * @returns the call's presentation, or `undefined` for a call outside the window.
 */
export function toolCallPresentation(
  snapshot: Pick<ConversationSnapshot, 'nodes' | 'runningCalls'>,
  callId: string,
): ToolCallPresentation | undefined {
  for (const call of snapshot.runningCalls) {
    const found = visit(call, callId)
    if (found !== undefined) return found
  }
  for (const node of snapshot.nodes) {
    if (node.kind !== 'tool-result') continue
    const found = visit(node, callId)
    if (found !== undefined) return found
  }
  return undefined
}
