/** Project activity tab title. */
import type { ReactNode } from 'react'
import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'

/** Activity tab title props assembled by the title seat. */
export type ActivityTitleProps = PropsRuntime<'sidebar.right.pane.tab.title'> & PropsLocale<'projectActivity'>

export function ActivityTitle({ t }: ActivityTitleProps): ReactNode {
  return <span>{t('type.label')}</span>
}
