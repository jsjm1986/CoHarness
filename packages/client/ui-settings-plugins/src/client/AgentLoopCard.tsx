/** The agent loop's card: how many tool calls one step may run at once. */

import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
// Type-only: merges the Plugins page's `plugins.item` contract.
import type {} from '@deepseek-ai/dsh-client-ui-plugin-manager/client'
import { ValueField } from './fields.tsx'
import { PluginForm } from './PluginForm.tsx'
import type { AgentLoopCardFace } from './agent-loop-card-controller.ts'

/** Props the renderer binds for the agent-loop card. */
export type AgentLoopCardProps =
  PropsRuntime<'plugins.item'>
  & PropsLocale<'settings.plugins'>
  & InjectFace<AgentLoopCardFace>

/**
 * Render the agent-loop card.
 * @param props - locale copy, the card snapshot, its form actions, and the view the page asks for.
 * @returns the card's content for the asked view, or nothing when the namespace is unavailable.
 */
export function AgentLoopCard(props: AgentLoopCardProps) {
  const { t } = props
  const state = props.useAgentLoopCard(snapshot => snapshot)
  if (!state.available) return null
  if (props.view === 'summary') return t('agentLoopDescription')
  return (
    <PluginForm t={t} state={state} onSave={props.save} onDiscard={props.discard}>
      <ValueField
        id="plugin-config-agent-loop-parallel"
        label={t('agentLoopMaxParallel')}
        hint={t('agentLoopMaxParallelHint')}
        overriddenLabel={t('overridden')}
        resetLabel={t('reset')}
        invalidLabel={t('invalidNumber')}
        numeric
        disabled={!state.writable}
        {...state.maxParallelToolCalls}
        onEdit={(text) => { props.edit('maxParallelToolCalls', text) }}
        onReset={() => { props.resetField('maxParallelToolCalls') }}
      />
    </PluginForm>
  )
}
