/** The Worktree settings card on the Plugins page: the archive cleanup switch. */
import { useId } from 'react'
import { Switch } from '@deepseek-ai/dsh-client-ui-primitives'
import { SettingsForm } from './settings-form/SettingsForm.tsx'
import type { SettingsFormLabels } from './settings-form/SettingsForm.tsx'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-plugin-manager/client'
import type { NS } from './locales.ts'
import type { WorktreeSettingsInjected } from './worktree-settings-form.ts'
import css from './WorktreeSettings.module.css'

export type WorktreeSettingsProps = PropsRuntime<'plugins.item'> & PropsLocale<typeof NS> & InjectFace<WorktreeSettingsInjected>

function formLabels(t: WorktreeSettingsProps['t']): SettingsFormLabels {
  return {
    unavailable: t('settings.unavailable'), readOnly: t('settings.readOnly'), saveFailed: t('settings.saveFailed'),
    save: t('settings.save'), saving: t('settings.saving'),
  }
}

/**
 * Render the Worktree settings: one switch that keeps every
 * checkout when its Session is archived. The summary view names the switch.
 * @param props - the Plugins page view, the staged form, and its actions.
 * @returns the row page's form, or the summary line.
 */
export function WorktreeSettings(props: WorktreeSettingsProps) {
  const { t } = props
  const id = useId()
  const state = props.useWorktreeForm(value => value)
  if (props.view === 'summary') return t('settings.retainOnArchive.title')
  const disabled = !state.writable || state.saving
  return <SettingsForm labels={formLabels(t)} state={state} onSave={props.save} onDiscard={props.discard}>
    <div className={css.row}>
      <div className={css.text}>
        <label className={css.title} htmlFor={id}>{t('settings.retainOnArchive.title')}</label>
        <p className={css.description}>{t('settings.retainOnArchive.description')}</p>
      </div>
      <Switch checked={state.retainOnArchive.text === 'true'} disabled={disabled} label={t('settings.retainOnArchive.title')}
        onChange={(next) => { props.edit('retainOnArchive', next ? 'true' : 'false') }} />
    </div>
  </SettingsForm>
}
