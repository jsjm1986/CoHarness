/** Empty workbench state; the toolbar remains available above it. */
import type { PropsLocale, PropsRuntime, PropsStore } from '@deepseek-ai/dsh-client-ui-slots'
import { Button, IconPlusOutline16 } from '@deepseek-ai/dsh-client-ui-primitives'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { createWorkbenchStore } from '../stores.ts'
import { NS } from '../locales.ts'
import css from './Workbench.module.css'

type Props = PropsRuntime<'conversation.workbench.empty'> & PropsLocale<typeof NS>
  & PropsStore<ReturnType<typeof createWorkbenchStore>>

/** Render the workbench's empty state. */
export function WorkbenchEmpty({ t, actions }: Props) {
  return (
    <div className={css.empty} data-workbench-empty-content="">
      <div className={css.emptyIcon} aria-hidden><IconPlusOutline16 /></div>
      <strong>{t('emptyTitle')}</strong>
      <span>{t('emptyBody')}</span>
      <Button variant="primary" onClick={() => { actions.openPicker() }}>
        {t('add')}
      </Button>
    </div>
  )
}
