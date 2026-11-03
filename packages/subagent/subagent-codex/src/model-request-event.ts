/** Durable input for one parent-governed native Codex model request. */
import type { NativeModelStreamRequest } from '@deepseek-ai/dsh-llm'

/** Exact secret-free native input retained before delegated model dispatch. */
export interface CodexModelRequest {
  /** Parent adapter route. */
  readonly provider: string
  /** Exact model on that route. */
  readonly model: string
  /** Prepared protocol and complete model-visible body. */
  readonly request: NativeModelStreamRequest
}

declare module '@deepseek-ai/dsh-session/types' {
  interface SessionEventMap {
    /** Exact secret-free child model input retained before delegated dispatch. */
    'subagent/codex-model-request': CodexModelRequest
  }
}
