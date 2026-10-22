import { memo, useEffect, useMemo, useState } from 'react'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-runtime/client'
import { JsonBlock } from '@deepseek-ai/dsh-client-ui-primitives'
import type {
  ChatNodeHookContext, ChatNodeOwnerProps, ChatViewSlotProps,
} from '../contract/slots.ts'
import type { ChatNode } from '../contract/chat-nodes.ts'
import css from './ChatView.module.css'

interface ChatNodeSeatProps extends ChatNodeOwnerProps {
  readonly nodeKey: string
  /** Mounted but collapsed behind the turn's process toggle. */
  readonly folded?: boolean
  readonly useSession: ChatViewSlotProps['useSession']
  readonly renderSlot: ChatViewSlotProps['renderSlot']
  readonly t: ChatViewSlotProps['t']
}

type RoutedChatNodeOwner = {
  [Kind in ChatNode['kind']]: ChatNodeOwnerProps & { readonly node: ChatNode<Kind> }
}[ChatNode['kind']]

/** Subscribe and dispatch one stable Context key without observing sibling Nodes. */
export const ChatNodeSeat = memo(function ChatNodeSeat({
  nodeKey, folded, groupPart, selectedCallId, cwd, openFile, openSkill, openCallDetails, inspectCall, forkAt,
  renderMessageImages, fileMentions, turnProcess, presentation, useSession, renderSlot, t,
}: ChatNodeSeatProps) {
  const node = useSession(snapshot => snapshot.chat.nodes.get(nodeKey))
  const routedNode = node as ChatNode | undefined
  // Folded members stay mounted for live updates; the generation cell advances
  // once per fold transition so bound disclosures collapse in place.
  const [disclosureReset] = useState(() => createSnapshotStore(0))
  useEffect(() => {
    if (folded === true) disclosureReset.set(disclosureReset.getSnapshot() + 1)
  }, [folded, disclosureReset])
  const hookContext = useMemo<ChatNodeHookContext>(
    () => ({ nodeKey, disclosureReset }), [nodeKey, disclosureReset])
  const owner = useMemo<ChatNodeOwnerProps | null>(() => node === undefined
    ? null
    : {
      selectedCallId,
      cwd,
      openFile,
      openSkill,
      openCallDetails,
      inspectCall,
      forkAt,
      renderMessageImages,
      fileMentions,
      ...(turnProcess === undefined ? {} : { turnProcess }),
      ...(groupPart === undefined ? {} : { groupPart }),
      ...(presentation === undefined ? {} : { presentation }),
    }, [
    node, selectedCallId, cwd, openFile, openSkill, openCallDetails, inspectCall, forkAt,
    renderMessageImages, fileMentions, turnProcess, groupPart, presentation,
  ])
  if (routedNode === undefined || owner === null) return null
  // Runtime dispatch owns the correlation: every Node's discriminant is the
  // keyed-slot entry passed alongside that same Node. TypeScript does not
  // distribute an object containing a union into a union of objects itself.
  const routedOwner = { ...owner, node: routedNode } as RoutedChatNodeOwner
  // One Node can draw two rows; the reasoning part needs its own anchor identity.
  const flowKey = groupPart === undefined || groupPart === 'response'
    ? routedNode.key
    : JSON.stringify([routedNode.key, groupPart])
  return (
    <div
      className={css.flowItem}
      hidden={folded === true ? true : undefined}
      data-turn-process-member={folded === true ? true : undefined}
      data-chat-anchor-key={flowKey}
      data-chat-flow-key={flowKey}
      data-chat-node-key={routedNode.key}
      data-chat-flow-kind={routedNode.kind}
      {...groupPart === undefined ? {} : { 'data-chat-group-part': groupPart }}
    >
      {renderSlot('conversation.chat.node', routedOwner, {
        entryKey: routedNode.kind,
        hookContext,
        fallback: (
          <JsonBlock
            label={t('message.unknownSurface', { type: routedNode.kind })}
            payload={routedNode.data}
            truncatedLabel={total => t('json.truncated', { total })}
          />
        ),
      })}
    </div>
  )
})
