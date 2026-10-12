/** Source-safe Agent Teams browser registration and Remote mount lifecycle. */

import type {
  TeamMemberView as TeamRosterMember,
  TeamView,
} from '@deepseek-ai/dsh-experimental-agent-team/client'
import type {} from '@deepseek-ai/dsh-experimental-agent-team/remote'
import type {
  ClientContext, SessionId, SubagentAddress,
} from '@deepseek-ai/dsh-client-runtime/client'
import type {} from '@deepseek-ai/dsh-api-remotes/client'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type { TypertRemoteContribution } from '@deepseek-ai/dsh-typert-protocol'
import { TeamAction, type TeamActionInjected, type TeamActionResult } from './TeamAction.tsx'
import { en, NS, zh, type TeamKey } from './locales.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** Agent Teams roster and task-board copy. */
    'agent-team': TeamKey
  }
}

/** Required browser services for RPC, navigation, slots, and localized copy. */
export const inject = ['sessions', 'remote', 'slots', 'locale']

function registerUi(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'client-ui-agent-team: dictionaries')
  const sessions = ctx.sessions
  const leadSessionId = (sessionId: SessionId): SessionId => {
    const address = sessions.binding(sessionId)?.session.getSnapshot().subagent?.address
    return address?.parentSessionId ?? sessionId
  }

  const actions: TeamActionInjected = {
    async load(sessionId): Promise<TeamActionResult<TeamView>> {
      return await ctx.remote.agentTeams.view(leadSessionId(sessionId))
    },
    async openTeammate(sessionId: SessionId, member: TeamRosterMember): Promise<void> {
      const parentSessionId = leadSessionId(sessionId)
      if (member.role !== 'teammate') {
        sessions.open(parentSessionId)
        return
      }
      await sessions.refreshSubagents(parentSessionId)
      // The refresh is asynchronous: skip navigation when the user has already
      // moved to another session view while it was in flight.
      if (sessions.list.getSnapshot().current !== sessionId) return
      const address: SubagentAddress = { parentSessionId, childSessionId: sessions.keyFor?.(member.id, sessions.runtimeIdentityFor?.(parentSessionId)) ?? member.id, mode: 'continuable' }
      sessions.openSubagent(address)
    },
  }

  ctx.slots.inject(
    'conversation.session.header.actions',
    () => ctx.slots.register({
      name: 'conversation.session.header.actions',
      id: 'agent-team',
      order: 20,
      locale: NS,
      inject: () => actions,
    }, TeamAction),
  )
}

/**
 * Mount one generated Team Remote contribution, then register its browser UI.
 * @param ctx - Client Context carrying navigation, locale, slot, and Remote services.
 * @param contribution - generated Team descriptors selected by the browser entry.
 * @returns disposer for both the UI registrations and Remote namespace.
 */
export async function mountAgentTeamUi(
  ctx: ClientContext,
  contribution: TypertRemoteContribution,
): Promise<() => Promise<void>> {
  const disposeRemote = await ctx.remote.$mount(contribution)
  const ui = ctx.inject(['sessions', 'remote.agentTeams', 'slots', 'locale'], registerUi)
  try {
    await ui
  } catch (error) {
    await ui.dispose()
    await disposeRemote()
    throw error
  }
  return async () => {
    await ui.dispose()
    await disposeRemote()
  }
}
