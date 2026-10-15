/** Empty workbench state; the toolbar remains available above it. */
import type { PropsLocale, PropsRuntime, PropsStore } from '@deepseek-ai/dsh-client-ui-slots'
import { Button, IconPlusOutline16, IconSplitPanesOutline16 } from '@deepseek-ai/dsh-client-ui-primitives'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { createWorkbenchStore } from '../stores.ts'
import { NS } from '../locales.ts'
import css from './Workbench.module.css'

type Props = PropsRuntime<'conversation.workbench.empty'> & PropsLocale<typeof NS>
  & PropsStore<ReturnType<typeof createWorkbenchStore>>

/** Render the workbench's empty state: a guidance card naming what panes are for. */
export function WorkbenchEmpty({ t, actions, viewport }: Props) {
  return (
    <div className={css.empty} data-workbench-empty-content="">
      <div className={css.emptyIcon} aria-hidden><IconSplitPanesOutline16 /></div>
      <strong>{t('emptyTitle')}</strong>
      <span>{t(viewport.pendingIdentity === true ? 'layoutPending' : 'emptyBody')}</span>
      <ul className={css.emptyHints}>
        <li>{t('emptyHintCompare')}</li>
        <li>{t('emptyHintParallel')}</li>
        <li>{t('emptyHintCapacity')}</li>
      </ul>
      <Button variant="primary" disabled={viewport.pendingIdentity === true} onClick={() => { actions.openPicker() }}>
        <IconPlusOutline16 />
        {t('add')}
      </Button>
    </div>
  )
}
