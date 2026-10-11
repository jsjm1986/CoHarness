import { IconShieldOutline16 } from '@deepseek-ai/dsh-client-ui-primitives'
import type { HostObservable, InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { CollaborationSnapshot } from './collaboration-client.ts'
import type { NS } from './locales.ts'
import css from './StewardDock.module.css'

/** Registration-side collaboration state for the steward notice row. */
export interface StewardDockInjected {
  hooks: {
    /** Shared Gateway collaboration snapshot, bound as useCollaboration. */
    collaboration: HostObservable<CollaborationSnapshot>
  }
}

/** Full input-dock steward notice props. */
export type StewardDockProps =
  PropsRuntime<'conversation.input.dock'>
  & InjectFace<StewardDockInjected>
  & PropsLocale<typeof NS>

/**
 * The notice row above the composer while the reserved steward space is
 * active: every steward action is audited and SQL writes need an in-session
 * approval. Any other scope renders nothing.
 * @param props - composed slot props.
 * @returns the warn-family notice, or null outside steward scope.
 */
export function StewardDock({ useCollaboration, t }: StewardDockProps) {
  const steward = useCollaboration(
    snapshot => snapshot.context?.scope.kind === 'project'
      && snapshot.context.scope.steward === true,
  )
  if (!steward) return null
  return (
    <div className={css.dock}>
      <div className={css.bar} role="note">
        <span className={css.glyph} aria-hidden><IconShieldOutline16 size={16} /></span>
        <span className={css.lead}>{t('steward.banner.lead')}</span>
        <span className={css.rest}>{t('steward.banner.rest')}</span>
      </div>
    </div>
  )
}
