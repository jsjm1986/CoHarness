/**
 * The web-search provider's card: its endpoint, its per-request search budget,
 * and the key — which is written through the credentials domain, never into
 * the settings section, so the literal never rides a response.
 */

import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
// Type-only: merges the Plugins page's `plugins.item` contract.
import type {} from '@deepseek-ai/dsh-client-ui-plugin-manager/client'
import { SecretField, ValueField } from './fields.tsx'
import { PluginForm } from './PluginForm.tsx'
import type { WebSearchCardFace } from './web-search-card-controller.ts'

/** Props the renderer binds for the web-search card. */
export type WebSearchCardProps =
  PropsRuntime<'plugins.item'>
  & PropsLocale<'settings.plugins'>
  & InjectFace<WebSearchCardFace>

/**
 * Render the web-search card.
 * @param props - locale copy, the card snapshot, its form actions, and the view the page asks for.
 * @returns the card's content for the asked view, or nothing when the namespace is unavailable.
 */
export function WebSearchCard(props: WebSearchCardProps) {
  const { t } = props
  const state = props.useWebSearchCard(snapshot => snapshot)
  if (!state.available) return null
  if (props.view === 'summary') return t('webSearchDescription')
  const disabled = !state.writable
  return (
    <PluginForm t={t} state={state} onSave={props.save} onDiscard={props.discard}>
      <SecretField
        id="plugin-config-web-search-key"
        label={t('webSearchApiKey')}
        hint={state.apiKeyWritable ? t('webSearchApiKeyHint') : t('webSearchApiKeyManaged')}
        // The credentials domain owns this control independently from the
        // settings namespace. In a project runtime the endpoint and quota may
        // be project-managed while the shared deployment key remains read-only.
        disabled={!state.apiKeyWritable}
        text={state.apiKey.text}
        configured={state.apiKeyConfigured}
        stateLabel={state.apiKeyConfigured ? t('webSearchApiKeySet') : t('webSearchApiKeyUnset')}
        onEdit={(text) => { props.edit('apiKey', text) }}
      />
      <ValueField
        id="plugin-config-web-search-endpoint"
        label={t('webSearchBaseUrl')}
        hint={t('webSearchBaseUrlHint')}
        overriddenLabel={t('overridden')}
        resetLabel={t('reset')}
        invalidLabel={t('invalidNumber')}
        disabled={disabled}
        {...state.baseURL}
        onEdit={(text) => { props.edit('baseURL', text) }}
        onReset={() => { props.resetField('baseURL') }}
      />
      <ValueField
        id="plugin-config-web-search-max-uses"
        label={t('webSearchMaxUses')}
        hint={t('webSearchMaxUsesHint')}
        overriddenLabel={t('overridden')}
        resetLabel={t('reset')}
        invalidLabel={t('invalidNumber')}
        numeric
        disabled={disabled}
        {...state.maxUses}
        onEdit={(text) => { props.edit('maxUses', text) }}
        onReset={() => { props.resetField('maxUses') }}
      />
    </PluginForm>
  )
}
