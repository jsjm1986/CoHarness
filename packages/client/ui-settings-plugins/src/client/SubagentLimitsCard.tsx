/** Upstream delegation-limit controls on the Subagent plugin's own Plugins page. */
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
// Type-only: merges the Plugins page's `plugins.item` contract.
import type {} from '@deepseek-ai/dsh-client-ui-plugin-manager/client'
import { PluginForm } from './PluginForm.tsx'
import { SubagentLimitsFields } from './SubagentLimitsFields.tsx'
import type { SubagentLimitsCardFace } from './subagent-limits-card-controller.ts'

/** Locale, owning slot and the delegation-limit form. */
export type SubagentLimitsCardProps = PropsRuntime<'plugins.item'>
  & PropsLocale<'settings.plugins'> & InjectFace<SubagentLimitsCardFace>

/**
 * Present the Host's depth and capacity with its scope-specific write policy.
 * @param props - bound form, actions and translated copy, and the view the page asks for.
 * @returns the card's content for the asked view, or nothing when the Host does not serve its namespace.
 */
export function SubagentLimitsCard(props: SubagentLimitsCardProps) {
  const state = props.useSubagentLimitsCard(value => value)
  if (!state.available) return null
  if (props.view === 'summary') return props.t('subagentDescription')
  return <PluginForm t={props.t} state={state} onSave={props.save} onDiscard={props.discard}>
    <SubagentLimitsFields t={props.t} state={state} edit={props.edit} resetField={props.resetField} />
  </PluginForm>
}
