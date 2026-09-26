/** Archived-session Settings page, browser half. */

import type {} from '@deepseek-ai/dsh-client-locale/client'
// Type-only: pulls the `workspaces` Context merge and the
// `useSessions`/`useWorkspaces` global standard props this page reads.
import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
// Type-only: pulls the settings.section SlotMap merge.
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import { ArchivedSessionsSection } from './ArchivedSessionsSection.tsx'
import type { ArchivedSessionsSectionInjected } from './ArchivedSessionsSection.tsx'
import { en, zh, type ArchivedSessionsLocaleKey } from './locales.ts'

export type { ArchivedSessionsSectionInjected, ArchivedSessionsSectionProps } from './ArchivedSessionsSection.tsx'
export type { ArchivedSessionsLocaleKey } from './locales.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** Archived-session page copy. */
    'settings.archivedSessions': ArchivedSessionsLocaleKey
  }
}

/** Dictionary namespace owned by this plugin. */
const NS = 'settings.archivedSessions'

/** Services required by the Settings registration and the archive write. */
export const inject = ['slots', 'locale', 'workspaces']

/** Contribute the archived-session page to Settings. */
export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'ui-settings-unarchive-sessions: dictionaries')

  const t = ctx.locale.bind(NS)
  const injected = (): ArchivedSessionsSectionInjected => ({
    unarchive: sessionId => ctx.workspaces.unarchiveSession(sessionId),
  })

  // Ordered last: restoring hidden sessions is the rarest settings act.
  ctx.slots.inject('settings.section', () => ctx.slots.register({
    name: 'settings.section',
    id: 'archived-sessions',
    order: 25,
    label: () => t('nav'),
    locale: NS,
    inject: injected,
  }, ArchivedSessionsSection))
}
