/** An independent, expandable notice explaining a non-human Turn trigger. */
import { useId, type ComponentType } from 'react'
import {
  IconAgentPresetOutline16, IconBranchOutline16, IconChevronDownOutline14,
  IconClockOutline16, IconCordisPluginOutline14, IconGlobeOutline14, IconGoalOutline16,
  IconQueueOutline14, IconSendOutline16, IconUsersOutline16, type IconProps,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { ChatNodeViewProps } from '../contract/slots.ts'
import { formatMessageClock } from './message-chrome.ts'
import { NoticeBody } from './ContextBody.tsx'
import { turnTriggerDetails, type TurnTriggerIcon } from './turn-trigger.ts'
import { useDisclosure } from './use-disclosure.ts'
import css from './TurnTriggerNodeView.module.css'

const TRIGGER_ICONS: Record<TurnTriggerIcon, ComponentType<IconProps>> = {
  request: IconSendOutline16,
  goal: IconGoalOutline16,
  agent: IconSendOutline16,
  team: IconUsersOutline16,
  subagent: IconAgentPresetOutline16,
  github: IconBranchOutline16,
  webhook: IconGlobeOutline14,
  schedule: IconClockOutline16,
  job: IconQueueOutline14,
  plugin: IconCordisPluginOutline14,
}

/** Render recorded trigger attribution above the whole-Turn disclosure. */
export function TurnTriggerNodeView({ node, t }: Pick<ChatNodeViewProps<'turn-trigger'>, 'node' | 't'>) {
  const { expanded: open, toggle } = useDisclosure()
  const bodyId = useId()
  const details = turnTriggerDetails(node.data)
  const TriggerIcon = TRIGGER_ICONS[details.icon]
  const date = new Date(node.data.time)
  const time = formatMessageClock(node.data.time, t)
  return (
    <section className={css.root} data-turn-trigger>
      <button className={css.header} type="button" aria-expanded={open} aria-controls={bodyId} onClick={toggle}>
        <span className={css.icon} aria-hidden><TriggerIcon size={14} /></span>
        <span className={css.title}>{t(details.title)}</span>
        <time className={css.time} dateTime={date.toISOString()}>{time}</time>
        <IconChevronDownOutline14 size={12} className={open ? css.openChevron : css.chevron} />
      </button>
      {open && <div id={bodyId} className={css.body}>
        <p className={css.explanation}>{t('message.trigger.explanation')}</p>
        <div className={css.content}><NoticeBody content={node.data.content} source={node.data.source} t={t} /></div>
      </div>}
    </section>
  )
}
