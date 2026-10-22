/**
 * Read-only skill lookup for an attached session. The Host resolves the
 * session's working directory and preset scope; clients submit names rather
 * than filesystem paths. Lookup never creates or resumes an Agent.
 */

import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { RpcRequest, RpcResponse } from './rpc.ts'

/** Skill catalog row (wire projection of the host SkillSummary; provider/source vocabulary stays host-side). */
export interface SkillEntry {
  /** Kebab-case identifier the user references as `/name` in the composer. */
  readonly name: string
  /** Short routing description. */
  readonly description: string
  /** Optional extra routing guidance. */
  readonly whenToUse?: string
  /** False marks a user-only skill (`disable-model-invocation`): invocable here, absent from the model catalog. */
  readonly modelInvocable: boolean
}

/** Current user-invocable instructions, without provider locators or invocation effects. */
export interface SkillPreview {
  readonly name: string
  readonly description: string
  /** Stored Markdown source; argument expansion and embedded commands are not executed. */
  readonly contentMarkdown: string
}

/**
 * Skill-domain reads. Invocation uses ordinary `session.prompt` text:
 * `dsh-tool-skill` recognizes whitespace-bounded `/name` tokens and injects
 * rendered instructions at the pre-step boundary.
 */
export interface SkillsApi {
  /**
   * List user-invocable skills without activating an Agent.
   * @param request - attached session whose working directory and preset select the catalog.
   * @param signal - cancellation for provider discovery.
   * @returns visible skill metadata, including the model invocation policy.
   */
  list(
    request: RpcRequest<{ sessionId: SessionId }>,
    signal?: AbortSignal,
  ): Promise<RpcResponse<{ skills: readonly SkillEntry[] }>>
  /**
   * Read current instructions without invoking the skill or activating an Agent.
   * @param request - attached session and skill name.
   * @param signal - cancellation for provider lookup.
   * @returns no `skill` when the name is absent or not user-invocable.
   */
  get(
    request: RpcRequest<{ sessionId: SessionId; name: string }>,
    signal?: AbortSignal,
  ): Promise<RpcResponse<{ skill?: SkillPreview }>>
}
