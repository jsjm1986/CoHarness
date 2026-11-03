/** Computer identity follows the rendered Session, including pooled workbench panes. */
import { ComputerBadge } from '@deepseek-ai/dsh-client-ui-primitives'
import { parseClientSessionKey } from '@deepseek-ai/dsh-client-runtime/client'
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { ScopeControlProps } from './ScopeControl.tsx'
import { runtimeComputerName } from './runtime-computer.ts'

/** Strict Session ownership plus the verified account's display metadata. */
export type SessionComputerLabelProps = PropsRuntime<'conversation.session.header.titleMeta'>
  & Pick<ScopeControlProps, 'useCollaboration' | 'useDeployment' | 't'>

/**
 * Show a Session's execution computer without changing its environment.
 * @param props - Session-bound selectors and verified account metadata.
 * @returns the execution computer name, or null before its ownership is known.
 */
export function SessionComputerLabel({ sessionId, useSessions, useDeployment, useCollaboration, t, compact }: SessionComputerLabelProps) {
  const runtime = useSessions(state => state.byId[sessionId]?.runtime)
  const showComputer = useDeployment(snapshot => snapshot.showComputer)
  const account = useCollaboration(state => state)
  const name = runtimeComputerName(runtime ?? parseClientSessionKey(sessionId)?.runtime, account)
  return !showComputer || compact || name === undefined ? null : <ComputerBadge name={name} label={t('computer.label')} />
}
