/** Execution location beside the existing Workspace chip while the conversation title is hidden. */
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import { ComputerBadge } from '@deepseek-ai/dsh-client-ui-primitives'
import { parseClientSessionKey } from '@deepseek-ai/dsh-client-runtime/client'
import { runtimeComputerName } from './runtime-computer.ts'
import type { ScopeControlProps } from './ScopeControl.tsx'
import css from './HeroComputerLabel.module.css'

type Props = PropsRuntime<'conversation.hero.context'> & Pick<ScopeControlProps, 'useDeployment' | 'useCollaboration' | 't'>

/**
 * Identify a blank conversation or an empty space's verified Runtime without adding a switching control.
 * @param props - rendered conversation identity and entry/account observables.
 * @returns a lightweight location, or nothing for single mode or the mobile header's location.
 */
export function HeroComputerLabel({ conversationId, compact, useSessions, useCollaboration, useDeployment, t }: Props) {
  const showComputer = useDeployment(snapshot => snapshot.showComputer)
  const account = useCollaboration(snapshot => snapshot)
  const runtime = useSessions(snapshot => conversationId === undefined ? undefined : snapshot.byId[conversationId]?.runtime)
  if (!showComputer || compact) return null
  if (conversationId === undefined && (account.status !== 'ready' || !account.contextVerified)) return null
  const address = conversationId === undefined ? undefined : parseClientSessionKey(conversationId)
  const environment = account.context?.environment
  const target = runtime ?? address?.runtime ?? (environment === undefined || account.context === undefined ? undefined
    : { ...account.context.scope, runtimeId: environment.id, nodeId: environment.nodeId,
      ...(environment.nodeName === undefined ? {} : { nodeName: environment.nodeName }) })
  const name = runtimeComputerName(target, account)
  if (name === undefined) return null
  const badge = <ComputerBadge name={name} label={t('computer.label')} />
  return conversationId === undefined ? <span className={css.fallback}>{badge}</span> : badge
}
