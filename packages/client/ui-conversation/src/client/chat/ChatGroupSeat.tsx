/** Stable process group container; display policy changes visibility, never member parents. */
import { memo, useEffect, useId, type ComponentProps, type ReactNode } from 'react'
import {
  IconAgentPresetOutline16, IconApiOutline14, IconBrowseOutline16, IconChevronDownOutline14,
  IconChevronUpOutline14, IconCodeOutline16, IconEditOutline16, IconGlobeOutline14,
  IconPlanOutline14, IconQuestionOutline14, IconSearchOutline16, IconSparkle16, IconThinkOutline14,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { ChatGroupMember } from '@deepseek-ai/dsh-client-runtime/client'
import type { ProcessActivity, ProcessGroupData } from '../contract/process-groups.ts'
import type { ChatPresentationPolicy } from '../presentation-policy.ts'
import type { ChatViewSlotProps } from '../contract/slots.ts'
import { ChatNodeSeat } from './ChatNodeSeat.tsx'
import { processTitle } from './step-process.ts'
import { useDisclosure } from './use-disclosure.ts'
import css from './ChatGroupSeat.module.css'

type SeatProps = Omit<ComponentProps<typeof ChatNodeSeat>, 'nodeKey' | 'groupPart' | 'folded'>

interface ChatGroupSeatProps extends SeatProps {
  readonly groupKey: string
  /** Whole-turn process-window fold state owned by ChatView. */
  readonly turnFolded: boolean
  /** Keys already folded by ChatView's whole-turn process window. */
  readonly foldedKeys: ReadonlySet<string>
  /** Grouped expansion policy plus per-mode live detail. */
  readonly presentation: ChatPresentationPolicy
  /** Latest turn deferral under the `next-input` collapse timing. */
  readonly deferCollapse: boolean
  /** Newest turn owning a process control. */
  readonly latestTurn: number | undefined
}

type ProcessTitleActivity = ProcessActivity | 'thinking'

const PROCESS_ICONS: Record<ProcessTitleActivity, ReactNode> = {
  thinking: <IconThinkOutline14 />,
  read: <IconBrowseOutline16 />,
  readImage: <IconBrowseOutline16 />,
  search: <IconSearchOutline16 />,
  edit: <IconEditOutline16 />,
  write: <IconEditOutline16 />,
  commands: <IconApiOutline14 />,
  code: <IconCodeOutline16 />,
  webSearch: <IconGlobeOutline14 />,
  webFetch: <IconBrowseOutline16 />,
  subagents: <IconAgentPresetOutline16 />,
  plan: <IconPlanOutline14 />,
  questions: <IconQuestionOutline14 />,
  tools: <IconSparkle16 />,
}

/** React key of one group member seat; the split parts of one Node need distinct keys. */
function memberSeatKey(member: ChatGroupMember): string {
  return member.groupPart === undefined ? member.key : `${member.key}:${member.groupPart}`
}

const ProcessGroupHeader = memo(function ProcessGroupHeader({ data, liveDetail, t, open, bodyId, toggle }: {
  readonly data: ProcessGroupData
  readonly liveDetail: boolean
  readonly t: ChatViewSlotProps['t']
  readonly open: boolean
  readonly bodyId: string
  readonly toggle: () => void
}) {
  const activity: ProcessTitleActivity = data.closed
    ? data.summary.counts[0]?.kind ?? 'thinking'
    : data.summary.running ?? 'thinking'
  const label = data.closed ? processTitle(data.summary, t)
    : data.summary.preparing === true
      ? t(`message.stepProcess.prepare.${activity === 'thinking' ? 'tools' : activity}`)
      : t(`message.stepProcess.${activity}`)
  // Live task detail rides only groups still producing it, and only while the
  // work-details policy shows it.
  const detail = liveDetail && !data.closed ? data.summary.runningDetail : ''
  const title = detail === '' ? label : `${label}${t('message.turnProcess.separator')}${detail}`
  return (
    <button
      type="button"
      className={css.title}
      aria-expanded={open}
      aria-controls={bodyId}
      data-process-activity={activity}
      onClick={toggle}
    >
      <span className={css.leading} aria-hidden="true">
        <span className={css.activityIcon} data-step-process-icon>{PROCESS_ICONS[activity]}</span>
        <span className={css.chevron} data-step-process-chevron>
          {open ? <IconChevronUpOutline14 /> : <IconChevronDownOutline14 />}
        </span>
      </span>
      <span className={css.label}>{title}</span>
    </button>
  )
})

/** Render one process group with a local disclosure and ChatView-owned whole-turn visibility. */
export const ChatGroupSeat = memo(function ChatGroupSeat({
  groupKey, turnFolded, foldedKeys, presentation, deferCollapse, latestTurn,
  useSession, ...props
}: ChatGroupSeatProps) {
  const group = useSession(s => s.chat.groups.get(groupKey))
  const { expanded: open, setExpanded: setOpen, toggle } = useDisclosure()
  const bodyId = useId()
  const turn = group === undefined ? undefined : (group.data as ProcessGroupData).turn
  const turnStatus = useSession(s => turn === undefined
    ? undefined
    : s.chat.timeline.turns.get(turn)?.status)
  // A folded Turn reopens to a collapsed group, not to the stale local state.
  useEffect(() => {
    if (turnFolded) setOpen(false)
  }, [turnFolded, setOpen])
  if (group === undefined) return null
  const data = group.data as ProcessGroupData
  // Detailed keeps the latest completed turn flat, like a running one, until the next input.
  const grouped = presentation.stepGrouping === 'collapsed'
    || (presentation.stepGrouping === 'history' && turnStatus !== 'open' && !(deferCollapse && turn === latestTurn))
  const liveDetail = presentation.liveProcessDetail
  return (
    <div
      className={css.root}
      data-chat-group-key={groupKey}
      data-chat-flow-key={groupKey}
      data-chat-anchor-key={`group:${groupKey}`}
      data-chat-turn={turn}
      data-step-process
      data-group-expanded-mode={!grouped || undefined}
      hidden={turnFolded}
    >
      {grouped && (
        <ProcessGroupHeader
          data={data}
          liveDetail={liveDetail}
          t={props.t}
          open={open}
          bodyId={bodyId}
          toggle={toggle}
        />
      )}
      <div
        id={bodyId}
        className={css.body}
        data-step-process-body
        hidden={grouped && !open}
      >
        <div className={css.content} data-step-process-content data-chat-flow="">
          {group.members.map(member => (
            <ChatNodeSeat
              {...props}
              key={memberSeatKey(member)}
              nodeKey={member.key}
              folded={turnFolded || foldedKeys.has(member.key)}
              {...member.groupPart === undefined ? {} : { groupPart: member.groupPart }}
              useSession={useSession}
            />
          ))}
        </div>
      </div>
    </div>
  )
})
