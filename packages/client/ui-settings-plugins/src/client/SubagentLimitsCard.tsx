/** Upstream delegation-limit controls in the account and project settings card. */
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import { PluginCard } from './PluginCard.tsx'
import { SubagentLimitsFields } from './SubagentLimitsFields.tsx'
import type { SubagentLimitsCardFace } from './subagent-limits-card-controller.ts'
import type {} from './slot-contract.ts'

/** Locale, owning slot and the delegation-limit form. */
export type SubagentLimitsCardProps = PropsRuntime<'settings.plugin.item'>
  & PropsLocale<'settings.plugins'> & InjectFace<SubagentLimitsCardFace>

/**
 * Present the Host's depth and capacity with its scope-specific write policy.
 * @param props - bound form, actions and translated copy.
 * @returns one expandable card, or nothing when the Host does not serve its namespace.
 */
export function SubagentLimitsCard(props: SubagentLimitsCardProps) {
  const state = props.useSubagentLimitsCard(value => value)
  return <PluginCard t={props.t} titleKey="subagentTitle" descriptionKey="subagentDescription"
    state={state} onSave={props.save} onDiscard={props.discard}>
    <SubagentLimitsFields t={props.t} state={state} edit={props.edit} resetField={props.resetField} />
  </PluginCard>
}
