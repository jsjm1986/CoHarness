import type { HostObservable, InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import { IconRightUpOutline16, Tooltip } from '@deepseek-ai/dsh-client-ui-primitives'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
import type { CollaborationSnapshot } from './collaboration-client.ts'
import type { NS } from './locales.ts'
import css from './LogoutButton.module.css'

/** Registration-side collaboration state used to identify an authenticated Gateway page. */
export interface LogoutButtonInjected {
  hooks: {
    /** Shared account-context state owned by the collaboration plugin. */
    collaboration: HostObservable<CollaborationSnapshot>
  }
}

/** Full props for the Gateway-only sidebar logout action. */
export type LogoutButtonProps =
  PropsRuntime<'sidebar.footer.action'>
  & InjectFace<LogoutButtonInjected>
  & PropsLocale<typeof NS>

/**
 * Render the Gateway logout form in the sidebar footer.
 *
 * The native form submission deliberately lets Gateway own cookie revocation,
 * audit logging, and the redirect to `/login`.
 * @param props - composed sidebar state, collaboration hook, and locale.
 * @returns a logout form for authenticated Gateway pages, or null for local Web.
 */
export function LogoutButton({ wide, useCollaboration, t }: LogoutButtonProps) {
  const state = useCollaboration(snapshot => snapshot)
  if (state.status !== 'ready') return null

  return (
    <form className={css.form} method="post" action="/logout">
      <Tooltip label={t('logout.label')} side="right" delayMs={500} disabled={wide}>
        <button
          type="submit"
          className={wide ? css.trigger : `${css.trigger} ${css.rail}`}
          aria-label={t('logout.label')}
        >
          <IconRightUpOutline16 size={wide ? 14 : 16} />
          {wide && <span className={css.label}>{t('logout.label')}</span>}
        </button>
      </Tooltip>
    </form>
  )
}
