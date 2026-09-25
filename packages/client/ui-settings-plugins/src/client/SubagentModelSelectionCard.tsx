/** Exact Subagent model-route preferences in the existing namespace settings surface. */
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import { PluginCard } from './PluginCard.tsx'
import { SubagentModelSelectionFields } from './SubagentModelSelectionFields.tsx'
import type { SubagentModelSelectionCardFace } from './subagent-model-selection-card-controller.ts'
import type {} from './slot-contract.ts'

/** Locale, owning settings slot and the staged model-route form. */
export type SubagentModelSelectionCardProps = PropsRuntime<'settings.plugin.item'>
  & PropsLocale<'settings.plugins'> & InjectFace<SubagentModelSelectionCardFace>

/**
 * Render the default-off model preference and exact route allowlist.
 * @param props - bound form, catalog actions and translated copy.
 * @returns one namespace card with atomic save and discard actions.
 */
export function SubagentModelSelectionCard(props: SubagentModelSelectionCardProps) {
  const state = props.useSubagentModelSelectionCard(value => value)
  return <PluginCard t={props.t} titleKey="subagentModelSelectionTitle"
    descriptionKey="subagentModelSelectionToggle" state={state} onSave={props.save} onDiscard={props.discard}>
    <SubagentModelSelectionFields t={props.t} state={state} toggleEnabled={props.toggleEnabled}
      toggleModel={props.toggleModel} retryCatalog={props.retryCatalog} />
  </PluginCard>
}
