/** Selected Runtime execution computer for the compact header and an empty desktop workbench. */
import { ComputerBadge } from '@deepseek-ai/dsh-client-ui-primitives'
import { parseClientSessionKey } from '@deepseek-ai/dsh-client-runtime/client'
import { runtimeComputerName } from './runtime-computer.ts'
import type { ScopeControlProps } from './ScopeControl.tsx'
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'

/** Verified account, Session selectors and the containing header presentation. */
export type ComputerControlProps = PropsRuntime<'shell.mobile.header.context'> & Pick<ScopeControlProps, 'useCollaboration' | 'useDeployment' | 't'>

/**
 * Resolve the selected conversation's execution computer, or its space's computer without a conversation.
 * @param props - Session-bound selection, verified directory metadata and compact presentation.
 * @returns a passive computer name, or null when its location is unknown or a desktop Session header already displays it.
 */
export function ComputerControl({ useDeployment, useCollaboration, useSessions, compact, t }: ComputerControlProps) {
  const showComputer = useDeployment(snapshot => snapshot.showComputer)
  const state = useCollaboration(snapshot => snapshot)
  const current = useSessions(snapshot => snapshot.current)
  const selected = useSessions(snapshot => current === undefined ? undefined : snapshot.byId[current]?.runtime)
  const context = state.context
  const environment = context?.environment
  if (!showComputer || state.status !== 'ready' || context === undefined || environment === undefined) return null
  if (!compact && current !== undefined) return null
  const target = current === undefined ? { ...context.scope, runtimeId: environment.id, nodeId: environment.nodeId,
    ...(environment.nodeName === undefined ? {} : { nodeName: environment.nodeName }) }
    : selected ?? parseClientSessionKey(current)?.runtime ?? { ...context.scope, runtimeId: environment.id, nodeId: environment.nodeId,
      ...(environment.nodeName === undefined ? {} : { nodeName: environment.nodeName }) }
  const name = runtimeComputerName(target, state)
  return name === undefined ? null : <ComputerBadge name={name} label={t('computer.label')} />
}
