import { memo } from 'react'
import type { ChatSnapshot, ObservableSnapshot } from '@deepseek-ai/dsh-client-runtime/client'
import type { InjectFace, PropsRenderSlots } from '@deepseek-ai/dsh-client-ui-slots'
import type { PerformanceUsageMode } from '../../submission-settings.ts'
import type { ChatNodeViewProps, TurnTailOwnerProps } from '../contract/slots.ts'
import { hasAssistantReplyContent } from '../contract/assistant-content.ts'
import type { ChatNode } from '../contract/chat-nodes.ts'
import { MessageIconActions } from './MessageIconActions.tsx'
import { TurnTimePanel, TurnUsagePanel } from './TurnUsagePanel.tsx'
import { assistantText } from './turn-assistant.ts'
import css from './TurnTailNodeView.module.css'

/** Registration-side inject face carrying the live performance detail preference. */
export interface TurnTailPerformanceInjected {
  hooks: {
    /** Persisted statistics detail bound as usePerformanceUsage. */
    performanceUsage: ObservableSnapshot<PerformanceUsageMode>
  }
}

type TurnTailNodeViewProps = ChatNodeViewProps<'turn-tail'>
  & PropsRenderSlots<'conversation.chat.turnTail' | 'conversation.chat.assistant-actions'>
  & InjectFace<TurnTailPerformanceInjected>

/** Latest meaningful Turn content: skips the footer, its process row, and optionally the max-tokens notice. */
function lastContent(snapshot: ChatSnapshot, turn: number, skipWarning: boolean): ChatNode | undefined {
  const keys = snapshot.locations.getTurn(turn)
  for (let index = keys.length - 1; index >= 0; index--) {
    const node = snapshot.nodes.get(keys[index] as string) as ChatNode | undefined
    if (node === undefined || node.kind === 'turn-tail' || node.kind === 'turn-process'
      || (skipWarning && node.kind === 'turn-max-tokens')) continue
    return node
  }
  return undefined
}

/** Turn-local actions and feature tail over the Location index, independent of Assistant placement. */
export const TurnTailNodeView = memo(function TurnTailNodeView({
  node, openFile, forkAt, renderSlot, t, useSession, usePerformanceUsage,
}: TurnTailNodeViewProps) {
  const detailed = usePerformanceUsage(mode => mode) === 'detailed'
  const data = node.data
  const hasLaterChatNode = useSession(snapshot =>
    (lastContent(snapshot.chat, data.turn, true)?.anchorSeq ?? -1) > (data.closing?.finalNode.seq ?? data.seq))
  // The action row reveals persistently only while this latest Turn still
  // ends in a response; trailing input or notices keep it hover-only.
  const endsWithResponse = useSession((snapshot) => {
    if (snapshot.chat.timeline.turnOrder.at(-1) !== data.turn) return false
    const last = lastContent(snapshot.chat, data.turn, false)
    const block = last?.kind === 'assistant-step' ? last.data.blocks.findLast(candidate =>
      (candidate.kind !== 'text' && candidate.kind !== 'reasoning') || candidate.text.trim() !== '') : undefined
    return block !== undefined && hasAssistantReplyContent([block])
  })
  const turn = node.location.kind === 'turn' || node.location.kind === 'step'
    ? node.location.turn
    : undefined
  if (turn === undefined) return null
  const closing = data.closing
  const owner: TurnTailOwnerProps = { turn, seq: closing?.finalNode.seq ?? data.seq, openFile }
  const tail = renderSlot('conversation.chat.turnTail', owner)
  if (closing === null) return tail === null ? null : <div className={css.root} data-turn-tail={data.turn}>{tail}</div>
  const runMs = turn.start === undefined || turn.end === undefined
    ? undefined
    : Math.max(0, turn.end.time - turn.start.time)
  // Interruption-frozen partials carry no messageId, so they address no
  // durable message and contribute no per-message actions.
  const messageId = closing.finalNode.messageId
  const assistantActions = messageId === undefined
    ? null
    : renderSlot('conversation.chat.assistant-actions', { messageId })
  return (
    <div
      className={css.root}
      data-turn-tail={data.turn}
      data-actions-reveal={endsWithResponse ? 'always' : 'hover'}
    >
      {tail}
      <MessageIconActions
        text={assistantText(closing.blocks)}
        time={closing.time}
        clock="end"
        // The branch action sends the recorded turn/end seq, and the Host
        // cuts the transcript exactly there.
        onBranch={() => { forkAt(data.seq) }}
        branchUnavailable={data.branchUnavailable || hasLaterChatNode}
        className={css.actions}
        extraActions={assistantActions}
        usageAction={!detailed
          ? null
          : (
            <>
              {data.tokenUsage !== undefined && <TurnUsagePanel usage={data.tokenUsage} t={t} />}
              {runMs !== undefined && (
                <TurnTimePanel
                  runMs={runMs}
                  tokensPerSecond={data.tokensPerSecond}
                  ttftMs={data.ttftMs}
                  t={t}
                />
              )}
            </>
          )}
        t={t}
      />
    </div>
  )
})
