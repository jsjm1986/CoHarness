/** Exact Subagent model-route preferences on the plugin's own Plugins page. */
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
// Type-only: merges the Plugins page's `plugins.item` contract.
import type {} from '@deepseek-ai/dsh-client-ui-plugin-manager/client'
import { PluginForm } from './PluginForm.tsx'
import { SubagentModelSelectionFields } from './SubagentModelSelectionFields.tsx'
import type { SubagentModelSelectionCardFace } from './subagent-model-selection-card-controller.ts'

/** Locale, owning slot and the staged model-route form. */
export type SubagentModelSelectionCardProps = PropsRuntime<'plugins.item'>
  & PropsLocale<'settings.plugins'> & InjectFace<SubagentModelSelectionCardFace>

/**
 * Render the default-off model preference and exact route allowlist.
 * @param props - bound form, catalog actions and translated copy, and the view the page asks for.
 * @returns the card's content for the asked view, or nothing when the namespace is unavailable.
 */
export function SubagentModelSelectionCard(props: SubagentModelSelectionCardProps) {
  const state = props.useSubagentModelSelectionCard(value => value)
  if (!state.available) return null
  if (props.view === 'summary') return props.t('subagentModelSelectionToggle')
  return <PluginForm t={props.t} state={state} onSave={props.save} onDiscard={props.discard}>
    <SubagentModelSelectionFields t={props.t} state={state} toggleEnabled={props.toggleEnabled}
      toggleModel={props.toggleModel} retryCatalog={props.retryCatalog} />
  </PluginForm>
}
