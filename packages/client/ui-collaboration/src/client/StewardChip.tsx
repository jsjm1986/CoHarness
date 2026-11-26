import { IconShieldOutline16, Tooltip } from '@deepseek-ai/dsh-client-ui-primitives'
import type { HostObservable, InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import { conversationProject, type CollaborationSnapshot } from './collaboration-client.ts'
import type { NS } from './locales.ts'
import css from './StewardChip.module.css'

/** Registration-side collaboration state for the steward composer chip. */
export interface StewardChipInjected {
  hooks: {
    /** Shared Gateway collaboration snapshot, bound as useCollaboration. */
    collaboration: HostObservable<CollaborationSnapshot>
  }
}

/** Full composer status chip props. */
export type StewardChipProps =
  PropsRuntime<'conversation.input.status'>
  & InjectFace<StewardChipInjected>
  & PropsLocale<typeof NS>

/**
 * Marks sessions in the reserved steward space. Hover, focus, or tap opens
 * the audit and approval notice. Workspace panes follow their own session.
 * @param props - composed slot props.
 * @returns the chip for sessions in the steward space.
 */
export function StewardChip({ sessionId, useCollaboration, t }: StewardChipProps) {
  const steward = useCollaboration((snapshot): boolean => {
    const projectId = conversationProject(snapshot, sessionId)
    return projectId !== undefined
      && snapshot.context?.projects.some(
        project => project.projectId === projectId && project.kind === 'steward',
      ) === true
  })
  if (!steward) return null
  return (
    <Tooltip
      label={`${t('steward.banner.lead')} · ${t('steward.banner.rest')}`}
      side="top"
      portal
      openOnClick
      maxWidth={280}
    >
      <button type="button" className={css.chip} aria-label={t('steward.chip.label')}>
        <span className={css.icon} aria-hidden="true"><IconShieldOutline16 size={14} /></span>
        <span className={css.label} aria-hidden="true" data-clip-label>{t('steward.chip.label')}</span>
      </button>
    </Tooltip>
  )
}
