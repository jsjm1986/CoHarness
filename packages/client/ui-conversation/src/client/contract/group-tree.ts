/** Chat group-tree positions; business kind selects its level, and a Node at one level also has the effect of every inner level. */
import type { ChatConversationViewNode } from '@deepseek-ai/dsh-client-runtime/client'

/**
 * Group-tree positions from the outermost inward.
 * - `input`: the Node is an input of its Turn. An input before the Turn's
 *   process is the Turn's opening input; a later one is interleaved and keeps
 *   the whole Turn open.
 * - `turn`: the Node stays in its Turn outside any process group.
 * - `process`: the Node breaks process runs but stays outside the groups
 *   themselves (standalone rows such as retries).
 * - undefined: the Node joins the process run around it.
 *
 * An `assistant-step` Node places its rows without one: its reasoning row
 * joins the process run and its reply row stands outside it.
 */
export type ChatGroupTree = 'input' | 'turn' | 'process'

const DEPTH: Readonly<Record<ChatGroupTree, number>> = { input: 0, turn: 1, process: 2 }

/** Group-tree position assigned to each Chat renderer kind. */
const POSITIONS: Readonly<Record<string, ChatGroupTree>> = {
  user: 'input',
  steering: 'input',
  'turn-trigger': 'input',
  'system-prompt': 'turn',
  'developer-message': 'turn',
  'inbox-next-step': 'turn',
  'turn-process': 'turn',
  'turn-tail': 'turn',
  'turn-error': 'turn',
  'turn-max-tokens': 'turn',
  'model-retry': 'process',
}

/**
 * Read the group-tree position one Chat Node's business kind declares.
 * @param node - materialized Chat Node.
 * @returns the position, or undefined for Nodes that join the process run around them.
 */
export function chatGroupPosition(node: Pick<ChatConversationViewNode, 'kind'>): ChatGroupTree | undefined {
  return POSITIONS[node.kind]
}

/**
 * Test whether a Node stands at a group-tree position or outside it.
 * @param node - Chat Node.
 * @param position - group-tree position to compare against.
 * @returns whether the Node's position is `position` or an outer one.
 */
export function isAtOrOutside(node: Pick<ChatConversationViewNode, 'kind'>, position: ChatGroupTree): boolean {
  const level = chatGroupPosition(node)
  return level !== undefined && DEPTH[level] <= DEPTH[position]
}
