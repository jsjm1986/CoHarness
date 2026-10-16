import { IconShieldOutline16, Tooltip } from '@deepseek-ai/dsh-client-ui-primitives'
import type { HostObservable, InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import { conversationProject, type CollaborationSnapshot } from './collaboration-client.ts'
import type { NS } from './locales.ts'
import css from './StewardChip.module.css'

/** Registration-side collaboration state for the steward tool-row chip. */
export interface StewardChipInjected {
  hooks: {
    /** Shared Gateway collaboration snapshot, bound as useCollaboration. */
    collaboration: HostObservable<CollaborationSnapshot>
  }
}

/** Full input tool-row steward chip props. */
export type StewardChipProps =
  PropsRuntime<'conversation.input.left'>
  & InjectFace<StewardChipInjected>
  & PropsLocale<typeof NS>

/**
 * The warn chip inside the composer tool row while the pane's own session
 * belongs to the reserved steward space: the chip marks the audited channel
 * at a glance without claiming a row of its own, and its tooltip — hover,
 * keyboard focus, or a pinning click — carries the full audit/approval
 * clause. The marker follows the session's runtime, not the page scope, so
 * workbench panes holding another scope's conversations render nothing.
 * @param props - composed slot props.
 * @returns the warn chip, or null for sessions outside the steward space.
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
