/** Client-safe event declarations owned by the agent-preset domain. */
import type { SessionId } from '@deepseek-ai/dsh-session/types'

declare module '@deepseek-ai/cordis' {
  interface Events {
    /**
     * One session committed a different agent preset to its durable log.
     * Consumers invalidate only state derived from that session's composition.
     * @mode emit
     * @param sessionId - the session whose composition changed.
     * @param agentPreset - the preset recorded by the committed selection.
     */
    'agent-preset/selected'(sessionId: SessionId, agentPreset: string): void
    /**
     * A live Agent was re-linked to a different standing preset composition.
     * Consumers refresh Agent-scoped registrations derived from the scope chain.
     * @mode emit
     */
    'agent-preset/recomposed'(): void
  }
}

export {}
