/**
 * The web-search provider's card: the switch between Messages search and the
 * Search and Fetch APIs, the selected API's endpoint and per-search limit, and
 * the key — which is written through the credentials domain, never into
 * the settings section, so the literal never rides a response.
 */

import { Switch } from '@deepseek-ai/dsh-client-ui-primitives'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
// Type-only: merges the Plugins page's `plugins.item` contract.
import type {} from '@deepseek-ai/dsh-client-ui-plugin-manager/client'
import { SecretField, ValueField } from './fields.tsx'
import { PluginForm } from './PluginForm.tsx'
import styles from './WebSearchCard.module.css'
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
  const disabled = !state.writable || state.saving
  const searchApi = state.useSearchApi
  const limitField = searchApi ? 'count' : 'maxUses'
  return (
    <PluginForm t={t} state={state} onSave={props.save} onDiscard={props.discard}>
      {state.apiSwitchAvailable && (
        <div className={styles.feature}>
          <label className={styles.toggleRow}>
            <span>{t('webSearchUseSearchApi')}</span>
            <Switch checked={searchApi} label={t('webSearchUseSearchApi')} disabled={disabled || state.apiSwitchBlocked}
              onChange={(checked) => { props.setSearchApi(checked) }} />
          </label>
          <p className={styles.hint}>
            {t('webSearchUseSearchApiHint')}
            <a className={styles.link} href={t('webSearchSearchGuideUrl')} target="_blank" rel="noopener noreferrer">{t('webSearchSearchGuide')}</a>
          </p>
        </div>
      )}
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
        label={t(searchApi ? 'webSearchApiBaseUrl' : 'webSearchBaseUrl')}
        hint={t(searchApi ? 'webSearchApiBaseUrlHint' : 'webSearchBaseUrlHint')}
        overriddenLabel={t('overridden')}
        resetLabel={t('reset')}
        invalidLabel={t('invalidNumber')}
        disabled={disabled}
        {...state.baseURL}
        onEdit={(text) => { props.edit('baseURL', text) }}
        onReset={() => { props.resetField('baseURL') }}
      />
      <ValueField
        id={searchApi ? 'plugin-config-web-search-count' : 'plugin-config-web-search-max-uses'}
        label={t(searchApi ? 'webSearchCount' : 'webSearchMaxUses')}
        hint={t(searchApi ? 'webSearchCountHint' : 'webSearchMaxUsesHint')}
        overriddenLabel={t('overridden')}
        resetLabel={t('reset')}
        invalidLabel={t(searchApi ? 'webSearchInvalidCount' : 'invalidNumber')}
        numeric
        disabled={disabled}
        {...state[limitField]}
        onEdit={(text) => { props.edit(limitField, text) }}
        onReset={() => { props.resetField(limitField) }}
      />
    </PluginForm>
  )
}
