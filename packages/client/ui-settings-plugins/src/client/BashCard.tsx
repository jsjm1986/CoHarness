/** The shell plugin's card: the limits every command the agent runs is bound by. */

import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
// Type-only: merges the Plugins page's `plugins.item` contract.
import type {} from '@deepseek-ai/dsh-client-ui-plugin-manager/client'
import { ValueField } from './fields.tsx'
import { PluginForm } from './PluginForm.tsx'
import type { BashCardFace } from './bash-card-controller.ts'

/** Props the renderer binds for the shell card. */
export type BashCardProps =
  PropsRuntime<'plugins.item'>
  & PropsLocale<'settings.plugins'>
  & InjectFace<BashCardFace>

/**
 * Render the shell card: its one-liner on the Plugins page's Configuration
 * group, or the staged form on its own detail page.
 * @param props - locale copy, the card snapshot, its form actions, and the view the page asks for.
 * @returns the card's content for the asked view, or nothing when the namespace is unavailable.
 */
export function BashCard(props: BashCardProps) {
  const { t } = props
  const state = props.useBashCard(snapshot => snapshot)
  if (!state.available) return null
  if (props.view === 'summary') return t('bashDescription')
  const disabled = !state.writable
  return (
    <PluginForm t={t} state={state} onSave={props.save} onDiscard={props.discard}>
      <ValueField
        id="plugin-config-bash-timeout"
        label={t('bashTimeoutMs')}
        hint={t('bashTimeoutMsHint')}
        overriddenLabel={t('overridden')}
        resetLabel={t('reset')}
        invalidLabel={t('invalidNumber')}
        numeric
        disabled={disabled}
        {...state.timeoutMs}
        onEdit={(text) => { props.edit('timeoutMs', text) }}
        onReset={() => { props.resetField('timeoutMs') }}
      />
      <ValueField
        id="plugin-config-bash-output"
        label={t('bashMaxOutputBytes')}
        hint={t('bashMaxOutputBytesHint')}
        overriddenLabel={t('overridden')}
        resetLabel={t('reset')}
        invalidLabel={t('invalidNumber')}
        numeric
        disabled={disabled}
        {...state.maxOutputBytes}
        onEdit={(text) => { props.edit('maxOutputBytes', text) }}
        onReset={() => { props.resetField('maxOutputBytes') }}
      />
    </PluginForm>
  )
}
