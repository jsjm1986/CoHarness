import { memo } from 'react'
import { IconChevronDownOutline14 } from '@deepseek-ai/dsh-client-ui-primitives'
import type { ChatNodeViewProps } from '../contract/slots.ts'
import css from './TurnProcessNodeView.module.css'

/** Render a turn-level process summary and toggle its collapsed state. */
export const TurnProcessNodeView = memo(function TurnProcessNodeView({ node, turnProcess, t }: ChatNodeViewProps<'turn-process'>) {
  const data = node.data
  const open = turnProcess?.open ?? data.answerAnchorSeq === null
  const labels: string[] = []
  if (data.toolCallCount > 0) labels.push(t(data.toolCallCount === 1 ? 'message.turnProcess.toolCalls.one' : 'message.turnProcess.toolCalls.other', { count: data.toolCallCount }))
  if (data.messageCount > 0) labels.push(t(data.messageCount === 1 ? 'message.turnProcess.messages.one' : 'message.turnProcess.messages.other', { count: data.messageCount }))
  if (data.subagentCount > 0) labels.push(t(data.subagentCount === 1 ? 'message.turnProcess.subagents.one' : 'message.turnProcess.subagents.other', { count: data.subagentCount }))
  const label = labels.length === 0 ? t('message.turnProcess.thoughtForAWhile') : labels.join(t('message.turnProcess.separator'))
  return (
    <button
      type="button"
      className={css.root}
      data-open={open || undefined}
      data-turn-process={data.turn}
      aria-expanded={open}
      onClick={() => { turnProcess?.setOpen(!open) }}
    >
      <span className={css.label}>{label}</span>
      <IconChevronDownOutline14 className={css.chevron} />
    </button>
  )
})
