import { memo, useCallback, useMemo } from 'react'
import { JsonBlock } from '@deepseek-ai/dsh-client-ui-primitives'
import type { ChatNodeOwnerProps, ChatViewSlotProps } from '../contract/slots.ts'
import type { ChatNode } from '../contract/chat-nodes.ts'
import css from './ChatView.module.css'

interface ChatNodeSeatProps extends ChatNodeOwnerProps {
  readonly nodeKey: string
  readonly useSession: ChatViewSlotProps['useSession']
  readonly renderSlot: ChatViewSlotProps['renderSlot']
  readonly t: ChatViewSlotProps['t']
  /** Optional register/unregister callback so the parent can keep an
   *  O(1) key→HTMLElement index instead of querySelectorAll-walking the
   *  mounted tree on every scroll tick. When absent the row is still
   *  addressable via its data-chat-anchor-key attribute (tests, older hosts). */
  readonly onAnchorMount?: ((key: string, el: HTMLElement) => void) | undefined
  readonly onAnchorUnmount?: ((key: string) => void) | undefined
}

type RoutedChatNodeOwner = {
  [Kind in ChatNode['kind']]: ChatNodeOwnerProps & { readonly node: ChatNode<Kind> }
}[ChatNode['kind']]

/** Subscribe and dispatch one stable Context key without observing sibling Nodes. */
export const ChatNodeSeat = memo(function ChatNodeSeat({
  nodeKey, selectedCallId, cwd, openFile, inspectCall, forkAt,
  renderMessageImages, fileMentions, turnProcess, onAnchorMount, onAnchorUnmount,
  useSession, renderSlot, t,
}: ChatNodeSeatProps) {
  const node = useSession(snapshot => snapshot.chat.nodes.get(nodeKey))
  const routedNode = node as ChatNode | undefined
  const owner = useMemo<ChatNodeOwnerProps | null>(() => node === undefined
    ? null
    : {
      selectedCallId,
      cwd,
      openFile,
      inspectCall,
      forkAt,
      renderMessageImages,
      fileMentions,
      ...(turnProcess === undefined ? {} : { turnProcess }),
    }, [
    node, selectedCallId, cwd, openFile, inspectCall, forkAt, renderMessageImages, fileMentions, turnProcess,
  ])
  if (routedNode === undefined || owner === null) return null
  // Runtime dispatch owns the correlation: every Node's discriminant is the
  // keyed-slot entry passed alongside that same Node. TypeScript does not
  // distribute an object containing a union into a union of objects itself.
  const routedOwner = { ...owner, node: routedNode } as RoutedChatNodeOwner
  const key = routedNode.key
  // Stable ref callback so React doesn't detach/reattach on every render.
  // The parent provides stable onAnchorMount/Unmount callbacks; key is
  // derived from the routed node identity.
  const setRow = useCallback((el: HTMLDivElement | null): void => {
    if (el === null) onAnchorUnmount?.(key)
    else onAnchorMount?.(key, el)
  }, [key, onAnchorMount, onAnchorUnmount])
  return (
    <div
      className={css.flowItem}
      data-chat-anchor-key={key}
      data-chat-flow-key={key}
      data-chat-flow-kind={routedNode.kind}
      ref={setRow}
    >
      {renderSlot('conversation.chat.node', routedOwner, {
        entryKey: routedNode.kind,
        hookContext: nodeKey,
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
