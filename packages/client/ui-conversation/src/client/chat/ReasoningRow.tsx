/** Assistant reasoning disclosure, independent of Tool-call presentation. */
import { useEffect, useMemo, useRef } from 'react'
import { DisclosureRow, IconThinkOutline14, MarkdownText } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsRenderSlots } from '@deepseek-ai/dsh-client-ui-slots'
import type { ChatViewSlotProps, UseDisclosure } from '../contract/slots.ts'
import { useDisclosure as useStandaloneDisclosure } from './use-disclosure.ts'
import { markdownLabels } from '../markdown-labels.ts'
import { useThrottledVisualUpdate } from './use-throttled-visual-update.ts'
import a11yCss from './accessibility.module.css'
import css from './ReasoningRow.module.css'

function firstLine(text: string): string {
  const visible = text.trimStart()
  const newline = visible.indexOf('\n')
  return newline === -1 ? visible : visible.slice(0, newline)
}

function latestLine(text: string): string {
  const visible = text.trimEnd()
  const newline = visible.lastIndexOf('\n')
  return newline === -1 ? visible : visible.slice(newline + 1)
}

/**
 * Render a collapsed reasoning summary and complete, compact Markdown on expansion.
 * @param props.text - complete or streaming reasoning text.
 * @param props.running - whether this block is the streaming tail.
 * @param props.t - conversation locale seat for status and Markdown actions.
 * @param props.renderSlot - authorized renderer for the expanded body; standalone
 * rows without one draw the standard compact Markdown directly.
 * @returns the reasoning disclosure.
 */
export function ReasoningRow({ text, running, settledReasoningPreview = true, useDisclosure, t, renderSlot }: {
  text: string
  running: boolean
  /** Settled rows keep their first-line preview only while the preference allows it. */
  settledReasoningPreview?: boolean | undefined
  /** Seat-bound disclosure Hook; standalone rows fall back to unmanaged state. */
  useDisclosure?: UseDisclosure | undefined
  t: ChatViewSlotProps['t']
  renderSlot?: PropsRenderSlots<'conversation.chat.reasoning.body'>['renderSlot'] | undefined
}) {
  const { expanded, toggle } = (useDisclosure ?? useStandaloneDisclosure)()
  const summaryRef = useRef<HTMLSpanElement>(null)
  const labels = useMemo(() => markdownLabels(t), [t])
  const summary = (running ? latestLine(text) : firstLine(text)).replaceAll('**', '')
  const scheduleSummaryScroll = useThrottledVisualUpdate(() => {
    const element = summaryRef.current
    if (element === null) return
    element.scrollLeft = running ? element.scrollWidth - element.clientWidth : 0
  })
  useEffect(() => {
    scheduleSummaryScroll()
  }, [running, scheduleSummaryScroll, summary])

  return (
    <div className={css.root} data-variant="think" data-state={running ? 'running' : 'ok'}
      data-expanded={expanded || undefined}>
      {running && <span className={a11yCss.visuallyHidden}>{t('row.running')}</span>}
      <DisclosureRow
        rowClassName={css.row}
        leadingClassName={css.leading}
        chevronClassName={css.chevron}
        running={running}
        icon={<IconThinkOutline14 size={14} />}
        title={t('message.think')}
        open={expanded}
        expandable
        expandOnRowClick
        onToggle={toggle}
        collapsedContent={(running || settledReasoningPreview) && summary !== ''
          ? (
            <>
              <span className={css.separator} aria-hidden />
              <span ref={summaryRef} className={css.summary} data-follow-end={running || undefined}>{summary}</span>
            </>
          )
          : undefined}
      >
        <div className={css.thinkBody}>
          {renderSlot?.('conversation.chat.reasoning.body', { text, running })
            ?? <MarkdownText text={text} streaming={running} labels={labels} variant="compact" />}
        </div>
      </DisclosureRow>
    </div>
  )
}
