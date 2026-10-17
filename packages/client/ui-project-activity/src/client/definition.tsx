/** Static project-activity tab type and guide declaration. */
import type { TranslateNS } from '@deepseek-ai/dsh-client-locale/client'
import { IconUsersOutline16 } from '@deepseek-ai/dsh-client-ui-primitives'
import type { SidebarRightTabDefinition } from '@deepseek-ai/dsh-client-ui-sidebar-right/client'
import type {} from './locales.ts'

/** Activity tab kind. */
export const ACTIVITY_KIND = 'activity'

/** Activity implementation identity and keyed Slot dispatch key. */
export const ACTIVITY_ID = '@deepseek-ai/dsh-client-ui-project-activity'

/** Build the activity type with locale-live copy. */
export function activityDefinition(t: TranslateNS<'projectActivity'>): SidebarRightTabDefinition {
  return {
    id: ACTIVITY_ID,
    kind: ACTIVITY_KIND,
    priority: 'builtin',
    title: () => t('type.label'),
    guide: [{
      id: 'new', order: 35, title: () => t('guide.title'),
      description: () => t('guide.description'), icon: IconUsersOutline16,
    }],
  }
}
