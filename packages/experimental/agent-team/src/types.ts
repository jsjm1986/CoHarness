/** Public Agent Teams identities, durable records, and service request values. */

import type { ExecutionInheritance } from '@deepseek-ai/dsh-execution-authority'
import type { Branded } from '@deepseek-ai/dsh-brand'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import type { SessionId } from '@deepseek-ai/dsh-session'

/** Identifies the implicit team rooted at one top-level Session. */
export type TeamId = Branded<'TeamId'>

/**
 * Brand one root Session identity as its implicit Team identity.
 * @param id - Root Session identity.
 * @returns the same string branded as a Team identity.
 */
export function TeamId(id: SessionId | string): TeamId {
  return id as TeamId
}

/** Stable identifier for one task in a Team. */
export type TeamTaskId = Branded<'TeamTaskId'>

/**
 * Brand a validated task id.
 * @param id - Team-local task identity.
 * @returns the same string branded as a Team task identity.
 */
export function TeamTaskId(id: string): TeamTaskId {
  return id as TeamTaskId
}

/** Stable identifier for one durable peer message. */
export type TeamMessageId = Branded<'TeamMessageId'>

/**
 * Brand a generated peer-message id.
 * @param id - Durable mailbox message identity.
 * @returns the same string branded as a Team message identity.
 */
export function TeamMessageId(id: string): TeamMessageId {
  return id as TeamMessageId
}

/**
 * Teammate lifecycle. Continuable children of the Lead are always `active`;
 * `provisioning` and `failed` appear only in historical roster records.
 */
export type TeamMemberPhase = 'provisioning' | 'active' | 'failed'

/** Historical roster value written by earlier Team builds on every teammate lifecycle change. */
export interface TeamMemberSnapshot {
  readonly id: SessionId
  readonly name: string
  readonly description: string
  readonly provider: string
  readonly context: 'fresh' | 'fork'
  readonly phase: TeamMemberPhase
  readonly error?: string
}

/**
 * Version-1 roster value, kept only so historical Session logs decode. The
 * `model` field captured the member's declared route at activation; version-2
 * records and the current writer omit it.
 */
export interface TeamMemberSnapshotV1 extends TeamMemberSnapshot {
  /**
   * The route the member's own session would resume with, captured from the
   * live child Agent when it first became active. Absent on members activated
   * before this field existed and on members that never reached `active`.
   */
  readonly model?: string
}

/** Durable task lifecycle. */
export type TeamTaskStatus = 'pending' | 'in_progress' | 'completed' | 'deleted'

/** Whole durable task snapshot; every mutation increments {@link revision}. */
export interface TeamTaskSnapshot {
  readonly id: TeamTaskId
  readonly revision: number
  readonly subject: string
  readonly description: string
  readonly status: TeamTaskStatus
  readonly ownerId?: SessionId
  /** Immutable agent path captured at assignment; absent on unnamed historical owners. */
  readonly ownerName?: string
  readonly blockedBy: TeamTaskId[]
  readonly writeScopes: string[]
}

/** Runtime-enriched task view returned to tools and hosts. */
export interface TeamTaskView {
  readonly id: TeamTaskId
  readonly revision: number
  readonly subject: string
  readonly description: string
  readonly status: TeamTaskStatus
  readonly blockedBy: TeamTaskId[]
  readonly writeScopes: string[]
  readonly ownerId?: SessionId
  /** Immutable agent path captured at assignment; absent on unnamed historical owners. */
  readonly ownerName?: string
  readonly ready: boolean
  readonly writeScopeWarnings: string[]
}

/**
 * Durable Team state published to browser clients through the Lead Session's
 * `agentTeam` projection. `failure` names the first rejected persisted Team
 * record; tasks then stay at the last valid state.
 */
export interface TeamProjection {
  readonly enabled: boolean
  readonly tasks: TeamTaskView[]
  readonly failure?: string
}

declare module '@deepseek-ai/dsh-session-projection/types' {
  interface SessionProjectionMap {
    /** Saved selection and non-deleted task board of the Team rooted at the projected Session. */
    agentTeam: TeamProjection
  }
}

/** One peer message recorded by the historical Team mailbox. */
export interface TeamMessageSnapshot {
  readonly id: TeamMessageId
  readonly senderId: SessionId
  readonly senderName: string
  readonly targetId: SessionId
  readonly content: ContentBlock[]
}

/**
 * Version-1 mailbox value, kept only so historical Session logs decode. The
 * current writer delivers peer messages through the target Agent inbox
 * (`ctx.subagents.sendMessage`), which records no queue entry.
 */
export interface TeamMessageSnapshotV1 extends TeamMessageSnapshot {
  /** Captured participants; Team routing never recovers identity from the latest caller. */
  readonly gatewayExecutionScope?: ExecutionInheritance
  /** Whether the queued delivery may start an inactive target. */
  readonly delivery: 'quiet' | 'wakeup'
}

/** Source recorded by a target Session for one historical Team mailbox delivery. */
export interface TeamMessageSource {
  /** Verified adjacent routing-host scope persisted by version-1 deliveries. */
  readonly gatewayExecutionScope?: ExecutionInheritance
  readonly kind: 'team-message'
  readonly teamId: TeamId
  readonly messageId: TeamMessageId
  readonly senderId: SessionId
  readonly senderName: string
}

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    'team-message': TeamMessageSource
  }
}

/** Team-service defaults and deployment limits. */
export interface Config {
  /** Enable new roots without a saved selection before their first step; defaults to false. Resumes retain saved mode. */
  readonly defaultEnabled?: boolean
  /** Maximum non-deleted tasks retained by one Team. */
  readonly maxTasks?: number
}

/** Input for creating one shared task. */
export interface CreateTeamTaskRequest {
  readonly subject: string
  readonly description: string
  readonly blockedBy?: readonly TeamTaskId[]
  readonly writeScopes?: readonly string[]
}

/** Supported task mutation actions. */
export type TeamTaskAction =
  | 'claim'
  | 'release'
  | 'edit'
  | 'set_dependencies'
  | 'complete'
  | 'reopen'
  | 'reassign'
  | 'delete'

/** Compare-and-set mutation of one shared task. */
export interface UpdateTeamTaskRequest {
  readonly taskId: TeamTaskId
  readonly expectedRevision: number
  readonly action: TeamTaskAction
  readonly subject?: string
  readonly description?: string
  readonly blockedBy?: readonly TeamTaskId[]
  readonly writeScopes?: readonly string[]
  readonly owner?: SessionId
}

declare module '@deepseek-ai/dsh-session/types' {
  interface SessionEventMap {
    /** User-selected Team mode; child Agents use the selection of their runtime root. */
    'team/mode': { enabled: boolean }
    /**
     * Historical teammate lifecycle value; new teammates are continuable
     * entries in the Lead's subagent catalog. Version-1 records remain in
     * released logs and decode only — never written by the current writer.
     */
    'team/member':
      | { version: 1; teamId: TeamId; member: TeamMemberSnapshotV1 }
      | { version: 2; teamId: TeamId; member: TeamMemberSnapshot }
    /**
     * Whole shared-task value, stored only in the Team Lead Session.
     * Version-1 records remain in released logs and fold into the `agentTeam`
     * projection; the current writer emits only version 2.
     */
    'team/task':
      | { version: 1; teamId: TeamId; task: TeamTaskSnapshot }
      | { version: 2; teamId: TeamId; task: TeamTaskSnapshot }
    /**
     * Historical mailbox enqueue; new sends use the target Agent inbox.
     * Version-1 records remain in released logs and decode only.
     */
    'team/message/queued':
      | { version: 1; teamId: TeamId; message: TeamMessageSnapshotV1 }
      | { version: 2; teamId: TeamId; message: TeamMessageSnapshot }
    /**
     * Historical acknowledgement that the target Session recorded a queued
     * message. Version-1 records remain in released logs and decode only.
     */
    'team/message/delivered':
      | { version: 1; teamId: TeamId; messageId: TeamMessageId; targetId: SessionId }
      | { version: 2; teamId: TeamId; messageId: TeamMessageId; targetId: SessionId }
  }
}
