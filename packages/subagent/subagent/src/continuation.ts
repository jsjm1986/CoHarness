/**
 * Continuable-subagent orchestration behind `ctx.subagents`: stable child ids,
 * descriptor persistence, provider preparation, cold resume, authorization,
 * tree membership, and message routing. {@link ContinuableActivationRegistry}
 * owns the mutable process-local Activation graph and its settlement and
 * disposal lifecycle.
 *
 * A continuable child has one durable Session and at most one process-local
 * Activation. The Agent inbox is the only turn queue, so this manager owns
 * durable orchestration while the Agent loop owns all turn ordering and
 * execution. No continuable path creates a Task or an intermediate
 * result-bearing wrapper.
 *
 * Every resident member names one live subagent tree root: the durable
 * creation ancestry — verified through each creator's catalog — plus the
 * slash-separated path of sibling names that addresses the member tree-wide.
 *
 * @module @deepseek-ai/dsh-subagent
 */

import { randomUUID } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-working-directory'
import { executionAuthorityOf } from '@deepseek-ai/dsh-execution-authority'
import type { Agent, AgentOptions } from '@deepseek-ai/dsh-agent'
import { ReasoningEffortId, contentHasImage, createUserMessage } from '@deepseek-ai/dsh-llm'
import type { ContentBlock, MessageId, MessageSource } from '@deepseek-ai/dsh-llm'
import { SessionId, SessionLogOffset } from '@deepseek-ai/dsh-session'
import type { Session, SessionEvent, SessionHeader, UserMessage } from '@deepseek-ai/dsh-session'
import type { SessionPersistence } from '@deepseek-ai/dsh-session-persistence'
import type {} from '@deepseek-ai/dsh-session-query'
import type { SessionProjectionMap } from '@deepseek-ai/dsh-session-projection/types'
import {
  childSessionMeta,
  captureDelegatedPolicyOverrides,
  resolveChildAgentOptions,
  resolveChildDepth,
} from './child-agent.ts'
import {
  ContinuableActivationRegistry,
} from './continuation-activation.ts'
import type { Activation } from './continuation-activation.ts'
import {
  createAgentMessage,
  withResultDeliveryGuidance,
} from './continuation-messages.ts'
import { assertSubagentMaxDepth } from './depth.ts'
import { foldSubagentDescriptor, snapshotSubagentDescriptor } from './descriptor.ts'
import { catalogNames, establishCatalogChild } from './catalog.ts'
import { SubagentError, renderSubagentFailure } from './error.ts'
import { isAdjacentAgentSendMessageTool } from './internal.ts'
import type { SubagentDelivery } from './inbox.ts'
import type { ActivationObserver } from './lifecycle.ts'
import { resolveAgentPath } from './list-children.ts'
import {
  ROOT_AGENT_NAME, agentAddress, joinAgentPath, parentAgentPath, SiblingNameReservations,
} from './names.ts'
import type { SiblingNameReservation } from './names.ts'
import type { SubagentCatalogEntry, SubagentIdentityProjection } from './projection-types.ts'
import type {
  ContinuableCreateRequest,
  ContinuableCreateSpec,
  ContinuableStart,
  ContinuableStartSpec,
  SubagentInterruptAuthority,
  SubagentMemberNames,
  SubagentProvider,
  SubagentSendMessageOptions,
} from './types.ts'

/** Inputs shared by model steering and human prompt delivery. */
type ChildDeliveryOptions = { readonly message?: ReturnType<typeof createUserMessage> } & (
  | {
    readonly delivery: 'steer'
    /**
     * A provided host source is preserved on the user message; omission attributes
     * an Agent message to the parent.
     */
    readonly source?: MessageSource
    readonly signal: AbortSignal
  }
  | { readonly delivery: 'queue'; readonly source: MessageSource; readonly signal: AbortSignal })

/**
 * Inputs shared by every member delivery through a live tree root. The
 * message is materialized inside the child lock from the supplied parts, so
 * `source` stays the durable attribution of the accepted user message.
 */
interface MemberDeliveryOptions {
  readonly delivery: SubagentDelivery
  readonly source: MessageSource
  readonly signal: AbortSignal
  /** Re-check the caller's authority at the final synchronous admission cutoff. */
  readonly authorize?: () => void
  /** Runs once the message is admitted; sendMessage uses it for the parent-delivery flag. */
  readonly onAccepted?: () => void
}

/**
 * The state one ancestry link contributes: durable metadata and folded
 * projection values. Ancestor reads never consume the raw event log.
 */
interface AncestorInspection {
  readonly meta: SessionHeader
  readonly inheritedEventCount: ReturnType<typeof SessionLogOffset>
  readonly values: Partial<SessionProjectionMap> | undefined
}

/** One detached member read: durable metadata, the complete log, and folded projections. */
interface ContinuationInspection extends AncestorInspection {
  readonly events: readonly SessionEvent[]
}

/** Package-private hooks supplied by the owning service. */
interface ContinuationHost {
  /** Resolve one provider's detached continuable-creation contribution. */
  prepareContinuable(name: string, request: ContinuableCreateRequest): Promise<ContinuableCreateSpec>
  /**
   * Provider-owned static route defaults merged under the request's
   * `agentOptions`, or `undefined` when the provider derives its route from
   * the parent.
   */
  agentRouteDefaults(name: string): SubagentProvider['agentRouteDefaults']
  /** Build the lifecycle observer for one Activation residency epoch. */
  observeActivation(provider: string, childId: SessionId, carrier: Agent, parentSessionId: SessionId): ActivationObserver
  /** Read the current descriptor identity through the service-owned projection. */
  identityOf(session: Session): SubagentIdentityProjection | null | undefined
  /** Read a live Session's direct-child catalog, absent when the projection is unavailable. */
  catalogOf(session: Session): readonly SubagentCatalogEntry[] | undefined
}

/**
 * The continuable-subagent orchestration service behind `ctx.subagents`. Tool
 * schema and host adapters are consumers of this one contract; foreground
 * one-shot delegation keeps calling `ctx.subagents.start()` and never enters
 * this lifecycle.
 */
export class SubagentContinuationManager {
  private readonly activations: ContinuableActivationRegistry
  /** Sibling names held by creations that have not committed their catalog entry. */
  private readonly names = new SiblingNameReservations()

  constructor(
    private readonly ctx: Context,
    private readonly host: ContinuationHost,
    limits: () => { maxActivations: number; maxActivationsPerParent: number },
    maxActiveSubagents: () => number,
  ) {
    this.activations = new ContinuableActivationRegistry(
      ctx,
      (provider, childId, carrier, parentSessionId) => host.observeActivation(provider, childId, carrier, parentSessionId),
      limits,
      maxActiveSubagents,
    )
  }

  /**
   * Start one continuable background child and resolve at initial inbox acceptance.
   * Every earlier failure disposes any created handle and rolls back Activation
   * and parent ownership without returning either id.
   * @param spec - provider, delegation request, optional sibling name, and caller cancellation.
   * @returns the durable child id, accepted initial prompt message id, and model-facing name.
   */
  async startContinuable(spec: ContinuableStartSpec): Promise<ContinuableStart> {
    const request = spec.request
    const parent = request.parent
    this.activations.assertAdmitting(parent)
    const persistence = this.requirePersistence()
    assertSubagentMaxDepth(request.maxDepth)
    const childId = spec.childId ?? SessionId(randomUUID())
    this.activations.assertChildIdAvailable(childId)
    const childDepth = resolveChildDepth(parent, request.maxDepth)
    // Snapshot before any await: invalid descriptor JSON rejects the call
    // before a child exists, and the detached value is what reaches the log.
    const routeDefaults = this.host.agentRouteDefaults(spec.provider)
    const requestedOptions: AgentOptions | undefined = routeDefaults === undefined
      ? request.agentOptions
      : { ...routeDefaults, ...request.agentOptions }
    const agentOptions = resolveChildAgentOptions(parent, requestedOptions, childDepth)
    const agentProvider = agentOptions.provider
    const agentModel = agentOptions.model
    const agentReasoningEffort = agentOptions.reasoningEffort
    const descriptor = snapshotSubagentDescriptor({
      mode: 'continuable',
      provider: spec.provider,
      label: spec.label,
      ...agentProvider !== undefined ? { agentProvider } : {},
      ...agentModel !== undefined ? { agentModel } : {},
      ...agentReasoningEffort !== undefined ? { agentReasoningEffort } : {},
    })
    // Capture before the first await: a later parent switch belongs to the
    // parent's future, not to this child.
    const delegatedPolicies = captureDelegatedPolicyOverrides(parent)
    // The sibling name is claimed before any asynchronous startup so
    // concurrent creations under the same exact parent cannot collide.
    const ancestry = this.ancestryForChild(parent)
    const reservation = this.reserveName(parent, spec.name)
    const path = joinAgentPath(this.pathOf(parent, ancestry.root), reservation.name)

    // An idle continuation-managed parent must not settle while a caller is
    // still creating its child. A turn-scoped delegation does not need this,
    // but the service is also callable outside a turn.
    const releaseHold = this.activations.holdOwnership(parent, childId)
    try {
      const cwd = request.cwd === undefined
        ? await this.ctx.workingDirectory.ensure(parent, spec.signal)
        : await this.ctx.workingDirectory.resolve(parent, request.cwd, spec.signal)
      const prepared = await this.host.prepareContinuable(spec.provider, {
        sessionId: childId,
        cwd,
        parent,
        signal: spec.signal,
      })
      spec.signal.throwIfAborted()
      this.activations.assertAdmitting(parent)

      const inheritedEventCount = SessionLogOffset(prepared.seed?.length ?? 0)
      const seed = prepared.seed
      const messageId = await this.activations.locks.run(childId, async () => {
        spec.signal.throwIfAborted()
        this.activations.assertAdmitting(parent)
        this.activations.assertChildIdAvailable(childId)
        if (spec.childId !== undefined) {
          const persisted = await persistence.listSnapshots(spec.signal)
          spec.signal.throwIfAborted()
          this.activations.assertAdmitting(parent)
          this.activations.assertChildIdAvailable(childId)
          if (persisted.some(snapshot => snapshot.header.id === childId)) {
            throw new SubagentError(`subagent "${childId}" already exists`, 'DUPLICATE_CHILD')
          }
        }
        const activation = await this.activations.materialize({
          childId,
          provider: spec.provider,
          parent,
          root: ancestry.root,
          ancestors: ancestry.ancestors,
          path,
          create: {
            cwd,
            seed,
            meta: childSessionMeta(parent, childDepth, prepared.seed !== undefined, request.agentPreset),
            inheritedEventCount,
            delegatedPolicies,
            descriptor,
          },
          agentOptions,
          composition: { agentPreset: request.agentPreset },
          ...request.outputSchema === undefined ? {} : { outputSchema: request.outputSchema },
          signal: spec.signal,
        })
        const childHeader = activation.handle.agent.session.header
        return await this.submitMaterialized(
          activation,
          isAdjacentAgentSendMessageTool(this.ctx.get('tools')?.get('send_message', activation.handle.agent))
            ? withResultDeliveryGuidance(request.prompt)
            : request.prompt,
          { source: { kind: 'user', ...(delegatedPolicies.executionScope === undefined ? {}
            : { gatewayExecutionScope: delegatedPolicies.executionScope }) }, signal: spec.signal, delivery: 'queue' },
          parent,
          () => { establishCatalogChild(parent.session, childHeader, descriptor, reservation.name) },
        )
      })
      return { childId, messageId, name: agentAddress(path, childId) }
    } catch (error: unknown) {
      releaseHold()
      throw error
    } finally {
      // The catalog commit consumed the name on success; a failure frees it
      // for the next sibling either way.
      reservation.release()
    }
  }

  /**
   * Resolve the live subagent tree root from runtime ownership, independent of
   * creator residency. A root is the caller itself when it never became a
   * subagent member; a member reaches its root only while that exact owner
   * stays live.
   * @param caller - exact live Agent selecting the subagent tree.
   * @returns the live subagent tree root.
   * @throws {@link SubagentError} `UNAUTHORIZED` when the caller is stale or a
   *   member whose tree root is not live.
   */
  rootOf(caller: Agent): Agent {
    if (this.ctx.agents.get(caller.id) !== caller) {
      throw new SubagentError('subagent tree access requires the exact live caller', 'UNAUTHORIZED')
    }
    const identity = this.host.identityOf(caller.session)
    const delegated = caller.session.header.origin === 'subagent'
      || identity != null && caller.session.isOwnSeq(identity.seq)
    const activation = this.activations.get(caller.id)
    if (activation !== undefined && activation.handle.agent === caller
      && this.ctx.agents.get(activation.root.id) === activation.root) return activation.root
    if (delegated || activation !== undefined) {
      throw new SubagentError('agent has no active runtime owner', 'UNAUTHORIZED')
    }
    return caller
  }

  /**
   * Report the model-facing names of a live member and its direct creator.
   * @param agent - exact live root or resident tree member.
   * @returns `lead` for the root, otherwise the member's and creator's names or Session ids.
   * @throws {@link SubagentError} `UNAUTHORIZED` when the caller has no active runtime owner.
   */
  namesOf(agent: Agent): SubagentMemberNames {
    const root = this.rootOf(agent)
    if (root === agent) return { self: ROOT_AGENT_NAME }
    // rootOf returns another root only for the caller's own resident Activation.
    const activation = this.activations.get(agent.id) as Activation
    const parentId = activation.parentSession
    const parentPath = activation.path === undefined
      ? parentId === root.id ? '' : this.activations.get(parentId)?.path
      : parentAgentPath(activation.path)
    return { self: agentAddress(activation.path, agent.id), parent: agentAddress(parentPath, parentId) }
  }

  /**
   * Resolve one model-facing name or Session id into the durable member id it
   * addresses. `lead` names the caller's tree root; a slash-separated path
   * walks committed catalog names from the root. A simple name that matches
   * no committed catalog entry falls back to the raw Session id; a malformed
   * or unmatched slash path never does.
   * @param caller - exact live Agent selecting the subagent tree.
   * @param name - the target's name path or a raw Session id.
   * @param signal - caller cancellation forwarded to catalog reads.
   * @returns the durable Session id to address.
   * @throws {@link SubagentError} `AGENT_NAME_NOT_FOUND` for an unmatched slash path.
   */
  async resolveName(caller: Agent, name: string, signal?: AbortSignal): Promise<SessionId> {
    const root = this.rootOf(caller)
    if (name === ROOT_AGENT_NAME) return root.id
    const resolved = await resolveAgentPath(this.ctx, root.id, name, signal)
    if (resolved !== undefined) return resolved
    if (name.includes('/')) {
      throw new SubagentError(
        `agent name ${JSON.stringify(name)} was not found in this subagent tree; use list_agents to see the names`,
        'AGENT_NAME_NOT_FOUND',
      )
    }
    return SessionId(name)
  }

  /**
   * Deliver one model-authored message to another member of the sender's
   * subagent tree: the root, a sibling, a deeper descendant, or the sender's
   * direct parent. A missing member cold-resumes under the shared tree root
   * without requiring its own creator to be live.
   * @param sender - exact live Agent authorizing and originating the message.
   * @param targetId - durable session id of another member of the same tree.
   * @param content - model-authored content to deliver.
   * @param options - caller cancellation before acceptance.
   * @returns the accepted message's inbox id.
   */
  async sendMessage(
    sender: Agent,
    targetId: SessionId,
    content: ContentBlock[],
    options: SubagentSendMessageOptions,
  ): Promise<MessageId> {
    options.signal.throwIfAborted()
    const root = this.rootOf(sender)
    if (sender.id === targetId) {
      throw new SubagentError('send_message requires another agent in the subagent tree', 'UNAUTHORIZED')
    }
    this.activations.assertAdmitting(sender)
    const message = createAgentMessage(sender, agentAddress(this.pathOf(sender, root), sender.id), content)
    const senderActivation = this.activations.get(sender.id)
    return this.deliverToMember(root, targetId, [...message.content], {
      signal: options.signal,
      delivery: 'steer',
      source: message.source,
      authorize: () => { this.activations.assertAdmitting(this.rootOf(sender)) },
      onAccepted: () => {
        // A message to the sender's own direct parent replaces the parent's
        // closing echo: the settlement notice then omits the closing text.
        if (senderActivation?.handle.agent === sender && senderActivation.parentSession === targetId) {
          senderActivation.omitClosingText = true
        }
      },
    })
  }

  /** Capture creation ancestry separately from the root that owns the new instance. */
  private ancestryForChild(creator: Agent): { readonly root: Agent; readonly ancestors: readonly SessionId[] } {
    const root = this.rootOf(creator)
    const ancestors = this.activations.get(creator.id)?.ancestors ?? []
    return { root, ancestors: [...ancestors, creator.id] }
  }

  /** Claim a sibling name against the creator's committed catalog and in-flight siblings. */
  private reserveName(parent: Agent, requested: string | undefined): SiblingNameReservation {
    const entries = this.host.catalogOf(parent.session)
    if (entries === undefined) {
      throw new SubagentError(
        'naming subagents requires the subagentCatalog projection (load @deepseek-ai/dsh-session-projection)',
        'SUBAGENT_CONTROL_PROJECTIONS_UNAVAILABLE',
      )
    }
    return this.names.reserve(parent, catalogNames(entries), requested)
  }

  /** Path of an exact live tree member: `''` for the root, undefined for unnamed history. */
  private pathOf(member: Agent, root: Agent): string | undefined {
    return member === root ? '' : this.activations.get(member.id)?.path
  }

  /**
   * Queue one human-authored prompt as a distinct direct-child turn.
   * @param parent - exact live direct parent authorizing delivery.
   * @param childId - durable direct-child session id.
   * @param content - model-visible prompt blocks.
   * @param source - durable attribution for the human prompt.
   * @param signal - caller cancellation before inbox acceptance.
   * @returns the accepted durable message id.
   */
  async queuePrompt(
    parent: Agent,
    childId: SessionId,
    content: ContentBlock[],
    source: MessageSource,
    signal: AbortSignal,
  ): Promise<MessageId> {
    return this.deliverToChild(parent, childId, content, { source, signal, delivery: 'queue' })
  }

  /**
   * Steer one host-authored prompt to a direct continuable child.
   * @param parent - exact live direct parent authorizing delivery.
   * @param childId - durable direct-child session id.
   * @param content - model-visible prompt blocks.
   * @param source - durable attribution for the host prompt.
   * @param signal - caller cancellation before inbox acceptance.
   * @returns the accepted durable message id.
   */
  async steerPrompt(
    parent: Agent,
    childId: SessionId,
    content: ContentBlock[],
    source: MessageSource,
    signal: AbortSignal,
  ): Promise<MessageId> {
    return this.deliverToChild(parent, childId, content, { source, signal, delivery: 'steer' })
  }

  /** Route one parent-originated delivery through residency and cold resume. */
  private async deliverToChild(
    parent: Agent,
    childId: SessionId,
    content: ContentBlock[],
    options: ChildDeliveryOptions,
  ): Promise<MessageId> {
    this.activations.assertAdmitting(parent)
    const message = options.source === undefined
      ? createAgentMessage(parent, agentAddress(this.pathOf(parent, this.rootOf(parent)), parent.id), content)
      : createUserMessage({ content, source: options.source })
    const capturedOptions = { ...options, message }
    const releaseHold = this.activations.holdOwnership(parent, childId)
    try {
      return await this.deliverFollowup(parent, childId, content, capturedOptions)
    } catch (error: unknown) {
      releaseHold()
      throw error
    }
  }

  /** The delivery loop behind {@link deliverToChild}, run under the parent hold. */
  private async deliverFollowup(
    parent: Agent,
    childId: SessionId,
    content: ContentBlock[],
    options: ChildDeliveryOptions,
  ): Promise<MessageId> {
    while (true) {
      const live = await this.activations.locks.run(childId, async () => {
        const activation = this.activations.get(childId)
        if (activation === undefined) return this.coldResume(parent, childId, content, options)
        const disposal = activation.inbox.closing
        /* v8 ignore next 3 -- the send-versus-dispose cutoff needs a delivery to
         * observe the transaction inside the same critical section that opened it. */
        if (disposal !== undefined) {
          return disposal.then(() => undefined, () => undefined)
        }
        if (contentHasImage(content)) {
          await this.assertImageCapable(activation.handle.agent, options.signal)
          if (activation.inbox.closing !== undefined) {
            await Promise.allSettled([activation.inbox.closing])
            return undefined
          }
        }
        const messageId = await this.submitAdmitted(activation, content, options, parent)
        activation.announced = true
        return messageId
      })
      /* v8 ignore start -- only a delivery that lost the disposal cutoff retries. */
      if (live !== undefined) return live
      this.activations.assertAdmitting(parent)
      options.signal.throwIfAborted()
      /* v8 ignore stop */
    }
  }

  /**
   * Interrupt one live continuable child's current turn. Admission is
   * synchronous and the cancellation effect is asynchronous. An absent or
   * already-closing target is an accepted no-op after authority checks.
   * @param targetSessionId - the durable child session id to interrupt.
   * @param authority - the human parent address or exact live ancestor Agent.
   */
  interrupt(targetSessionId: SessionId, authority: SubagentInterruptAuthority): void {
    this.activations.interrupt(targetSessionId, authority)
  }

  /**
   * Route one member delivery through the live tree root: a resident target
   * submits after the same-tree check, the root receives it through its own
   * inbox lane, and an absent target restores under the root alone. A target
   * closing mid-route retries against the same lock serialization.
   */
  private async deliverToMember(
    root: Agent,
    childId: SessionId,
    content: ContentBlock[],
    options: MemberDeliveryOptions,
  ): Promise<MessageId> {
    while (true) {
      this.activations.assertAdmitting(root)
      options.signal.throwIfAborted()
      const result = await this.activations.locks.run(childId, async (): Promise<
        { readonly messageId: MessageId } | { readonly closing: Promise<void> }
      > => {
        if (childId === root.id) {
          if (contentHasImage(content)) await this.assertImageCapable(root, options.signal)
          const message = createUserMessage({ content, source: options.source })
          const stamped = await this.stampPrompt(root.session, message)
          options.signal.throwIfAborted()
          options.authorize?.()
          this.activations.assertAdmitting(root)
          this.activations.sendWaking(root, stamped, options.delivery)
          options.onAccepted?.()
          return { messageId: stamped.id }
        }
        const activation = this.activations.get(childId)
        if (activation === undefined) {
          const restored = await this.restoreTarget(root, childId, options)
          return { messageId: await this.submitMaterializedMember(restored, content, options, root) }
        }
        if (activation.root !== root) {
          throw new SubagentError(`subagent "${childId}" belongs to another subagent tree`, 'UNAUTHORIZED')
        }
        if (activation.inbox.closing === undefined && contentHasImage(content)) {
          await this.assertImageCapable(activation.handle.agent, options.signal)
        }
        if (activation.inbox.closing !== undefined) {
          return { closing: activation.inbox.closing }
        }
        return { messageId: await this.submitMemberAdmitted(activation, content, options, root) }
      })
      if ('messageId' in result) return result.messageId
      await Promise.allSettled([result.closing])
    }
  }

  /**
   * Cross the final admission cutoff for a tree-member delivery: attest a
   * human-originated source, re-check the caller's authority, and submit under
   * the tree root without requiring the target's own creator live.
   */
  private async submitMemberAdmitted(
    activation: Activation,
    content: ContentBlock[],
    options: MemberDeliveryOptions,
    root: Agent,
  ): Promise<MessageId> {
    const message = createUserMessage({ content, source: options.source })
    const stamped = await this.stampPrompt(activation.handle.agent.session, message)
    options.signal.throwIfAborted()
    options.authorize?.()
    const messageId = this.activations.submitMember(activation, stamped, options.delivery, root, options.signal)
    options.onAccepted?.()
    return messageId
  }

  /** Admit a member restored under the tree root, releasing it when admission fails. */
  private async submitMaterializedMember(
    activation: Activation,
    content: ContentBlock[],
    options: MemberDeliveryOptions,
    root: Agent,
  ): Promise<MessageId> {
    try {
      if (contentHasImage(content)) {
        await this.assertImageCapable(activation.handle.agent, options.signal)
        if (activation.inbox.closing !== undefined) {
          throw new SubagentError(`subagent "${activation.childId}" is closing`, 'ACTIVATION_CLOSING')
        }
      }
      const messageId = await this.submitMemberAdmitted(activation, content, options, root)
      activation.announced = true
      return messageId
    } catch (error: unknown) {
      try {
        await this.activations.dispose(activation)
      } catch (cleanupError: unknown) {
        this.ctx.logger.warn(
          `subagent continuation: disposal after member-admission failure also failed: ${renderSubagentFailure(cleanupError)}`,
        )
      }
      throw error
    }
  }

  /**
   * Cold-resume one absent tree member under its live root alone: the durable
   * creation ancestry — verified through each creator's committed catalog —
   * authorizes membership without requiring the member's own creator live.
   */
  private async restoreTarget(
    root: Agent,
    childId: SessionId,
    options: MemberDeliveryOptions,
  ): Promise<Activation> {
    const source = await this.inspectContinuation(childId, options.signal)
    options.signal.throwIfAborted()
    this.activations.assertAdmitting(root)
    // Fold only the child's own suffix: a fork seed replays the parent's log,
    // which may carry an ANCESTOR's descriptor when the parent is itself a
    // continuable child.
    const ownEvents = source.events.slice(source.inheritedEventCount)
    const descriptor = foldSubagentDescriptor(ownEvents)
    if (descriptor === undefined || descriptor.mode !== 'continuable') {
      throw new SubagentError(
        `subagent "${childId}" has no supported continuation state and cannot be resumed; choose a different target`,
        'NOT_RESUMABLE',
      )
    }
    const { ancestors, path } = await this.resolveCreationAncestry(source, options.signal, root)
    let activation: Activation
    try {
      const independentlySelected = hasIndependentPresetSelection(ownEvents)
      const agentPreset = independentlySelected
        ? source.values?.agentPreset ?? undefined
        : undefined
      if (independentlySelected && typeof agentPreset !== 'string') {
        throw new SubagentError(`subagent "${childId}" has no agent preset projection for restoration`, 'NOT_RESUMABLE')
      }
      activation = await this.activations.materialize({
        childId,
        provider: descriptor.provider,
        root,
        ancestors,
        path,
        agentOptions: {
          ...descriptor.agentProvider !== undefined ? { provider: descriptor.agentProvider } : {},
          ...descriptor.agentModel !== undefined ? { model: descriptor.agentModel } : {},
          ...descriptor.agentReasoningEffort !== undefined
            ? { reasoningEffort: ReasoningEffortId(descriptor.agentReasoningEffort) }
            : {},
        },
        composition: { agentPreset, persona: descriptor.persona, toolFilter: descriptor.toolFilter },
        signal: options.signal,
      })
    } catch (error: unknown) {
      options.signal.throwIfAborted()
      if (error instanceof SubagentError) throw error
      throw new SubagentError(`subagent "${childId}" is unavailable`, 'NOT_RESUMABLE', { cause: error })
    }
    return activation
  }

  /**
   * Walk the candidate's durable creation ancestry through each creator's
   * committed catalog until the supplied root's own entry verifies. Every
   * link contributes its recorded sibling name, so an unnamed historical link
   * ends the path below the root rather than failing membership.
   */
  private async resolveCreationAncestry(
    source: AncestorInspection,
    signal: AbortSignal,
    root: Agent,
  ): Promise<{ readonly ancestors: readonly SessionId[]; readonly path: string | undefined }> {
    const ancestors: SessionId[] = []
    const names: (string | undefined)[] = []
    const seen = new Set<SessionId>([source.meta.id])
    let { meta, inheritedEventCount, values } = source
    const pathFromRoot = (): string | undefined => names.reduce<string | undefined>(joinAgentPath, '')
    while (true) {
      signal.throwIfAborted()
      const parentId = meta.parentSession
      const identity = values?.subagent
      // An identity inside the inherited prefix is an ANCESTOR's descriptor
      // replayed by a fork seed, never this member's own creation edge.
      if (parentId === undefined || identity == null || identity.seq < inheritedEventCount) break
      if (seen.has(parentId)) throw new SubagentError('cyclic subagent creation ancestry', 'UNAUTHORIZED')
      seen.add(parentId)
      const parent = await this.inspectAncestor(parentId, signal)
      const entry = parent.values?.subagentCatalog?.find(candidate => candidate.id === meta.id)
      if (entry === undefined) {
        throw new SubagentError('subagent is absent from its creator catalog', 'UNAUTHORIZED')
      }
      ancestors.unshift(parentId)
      names.unshift('name' in entry ? entry.name : undefined)
      if (parentId === root.id) return { ancestors, path: pathFromRoot() }
      ;({ meta, inheritedEventCount, values } = parent)
    }
    throw new SubagentError(`agent "${source.meta.id}" is not a member of this subagent tree`, 'UNAUTHORIZED')
  }

  /**
   * Read one member's metadata, complete log, and folded projection values.
   * The Session query service covers live members — recent rows may not be
   * flushed — and reuses prepared cold reads; contexts without it restore
   * over the stored log, which already carries every creation event a resume
   * folds.
   */
  private async inspectContinuation(childId: SessionId, signal: AbortSignal): Promise<ContinuationInspection> {
    const query = this.ctx.get('sessionQuery')
    if (query !== undefined) {
      try {
        using observed = await query.observeSession(childId, { signal })
        return {
          meta: observed.header,
          events: observed.events,
          inheritedEventCount: observed.inheritedEventCount,
          values: observed.projections?.values,
        }
      } catch (error: unknown) {
        signal.throwIfAborted()
        throw new SubagentError(`subagent "${childId}" is unavailable`, 'NOT_RESUMABLE', { cause: error })
      }
    }
    const persistence = this.requirePersistence()
    let loaded: Awaited<ReturnType<typeof persistence.inspect>>
    try {
      loaded = await persistence.inspect(childId, signal)
    } catch (error: unknown) {
      signal.throwIfAborted()
      throw new SubagentError(`subagent "${childId}" is unavailable`, 'NOT_RESUMABLE', { cause: error })
    }
    const values = this.ctx.get('sessionProjections')?.restore(
      {}, loaded.events, SessionLogOffset(0), loaded.meta, loaded.inheritedEventCount,
    ).snapshot.values
    return {
      meta: loaded.meta,
      events: loaded.events,
      inheritedEventCount: loaded.inheritedEventCount,
      values,
    }
  }

  /**
   * Read one ancestor's identity state: durable metadata and folded projection
   * values, never the raw log. A live Session answers from memory — its
   * catalog rows may not be flushed — while a cold one restores over storage.
   */
  private async inspectAncestor(parentId: SessionId, signal: AbortSignal): Promise<AncestorInspection> {
    const live = this.ctx.get('sessions')?.get(parentId)
    if (live === undefined) return this.inspectContinuation(parentId, signal)
    signal.throwIfAborted()
    return {
      meta: live.header,
      inheritedEventCount: live.inheritedEventCount,
      values: this.ctx.get('sessionProjections')?.snapshot(live).values,
    }
  }

  /** Attest a human-originated source before the synchronous admission cutoff. */
  private async stampPrompt(session: Session, message: UserMessage): Promise<UserMessage> {
    const authority = executionAuthorityOf(this.ctx)
    if (authority === undefined || message.source.kind !== 'user' || 'gatewayExecutionScope' in message.source) {
      return message
    }
    return authority.stamp(session, message)
  }

  /** Close manager-wide admission and release every live Activation. */
  async drain(): Promise<void> {
    await this.activations.drain()
  }

  /**
   * Join progressing descendant work without cancelling it. Idle descendants
   * whose inboxes require a later wake stay resident and do not delay host
   * completion.
   * @param parent - exact live parent whose descendants are observed.
   * @returns whether work was joined and the host must recheck parent completion.
   */
  async waitForChildren(parent: Agent): Promise<boolean> {
    return this.activations.waitForChildren(parent)
  }

  /**
   * Report unsettled direct continuable work for one live parent without
   * awaiting, so a child-bound model tool execution can decide whether its
   * final structured result is acceptable.
   * @param parent - exact live parent whose direct continuable work is probed.
   * @returns whether a materialization lineage or resident Activation still
   *   claims that parent.
   */
  hasPendingDirectChildren(parent: Agent): boolean {
    return this.activations.hasPendingDirectChildren(parent)
  }

  /**
   * Stop only the continuable descendants of exact live host-owned parents.
   * @param parents - exact live roots whose continuable descendants must stop.
   */
  async drainDescendants(parents: readonly Agent[]): Promise<void> {
    await this.activations.drainDescendants(parents)
  }

  /**
   * Release selected resident direct children of one exact live parent.
   * @param parent - exact live direct parent authorizing the selected release.
   * @param childIds - durable direct-child ids to release when resident.
   */
  async drainChildren(parent: Agent, childIds: readonly SessionId[]): Promise<void> {
    await this.activations.drainChildren(parent, childIds)
  }

  /**
   * Cold-resume a persisted child: inspect and authorize its Session, fold the
   * generic descriptor, create the Activation through `ctx.agents.resume()`,
   * and submit the waiting turn. This never dispatches through a subagent
   * provider — the persisted Session already holds the initial prefix and the
   * descriptor is the whole reconstruction input.
   */
  private async coldResume(
    parent: Agent,
    childId: SessionId,
    content: ContentBlock[],
    options: ChildDeliveryOptions,
  ): Promise<MessageId> {
    const persistence = this.requirePersistence()
    let loaded: Awaited<ReturnType<typeof persistence.inspect>>
    try {
      loaded = await persistence.inspect(childId, options.signal)
    } catch (error: unknown) {
      options.signal.throwIfAborted()
      throw new SubagentError(`subagent "${childId}" is unavailable`, 'NOT_RESUMABLE', { cause: error })
    }
    options.signal.throwIfAborted()
    this.activations.assertAdmitting(parent)
    // Authorize the persisted header before folding: only the durable child's
    // exact live direct parent may continue it.
    this.activations.authorizeLineage(parent, childId, loaded.meta.parentSession)
    // The resident ancestry locates the tree root; the committed catalog link
    // contributes the name segment, when that history is addressable.
    const ancestry = this.ancestryForChild(parent)
    const entry = this.host.catalogOf(parent.session)?.find(candidate => candidate.id === childId)
    const path = joinAgentPath(
      this.pathOf(parent, ancestry.root),
      entry === undefined ? undefined : 'name' in entry ? entry.name : undefined,
    )
    // Fold only the child's own suffix: a fork seed replays the parent's log,
    // which may carry an ANCESTOR's descriptor when the parent is itself a
    // continuable child.
    const ownEvents = loaded.events.slice(loaded.inheritedEventCount)
    const descriptor = foldSubagentDescriptor(ownEvents)
    if (descriptor === undefined || descriptor.mode !== 'continuable') {
      throw new SubagentError(
        `subagent "${childId}" has no supported continuation state and cannot be resumed; choose a different target`,
        'NOT_RESUMABLE',
      )
    }
    let activation: Activation
    try {
      const independentlySelected = hasIndependentPresetSelection(ownEvents)
      const agentPreset = independentlySelected
        ? this.ctx.get('sessionProjections')?.restore(
          {}, loaded.events, SessionLogOffset(0), loaded.meta, loaded.inheritedEventCount,
        ).snapshot.values.agentPreset ?? undefined
        : undefined
      if (independentlySelected && typeof agentPreset !== 'string') {
        throw new SubagentError(`subagent "${childId}" has no agent preset projection for restoration`, 'NOT_RESUMABLE')
      }
      activation = await this.activations.materialize({
        childId,
        provider: descriptor.provider,
        parent,
        root: ancestry.root,
        ancestors: ancestry.ancestors,
        path,
        agentOptions: {
          ...descriptor.agentProvider !== undefined ? { provider: descriptor.agentProvider } : {},
          ...descriptor.agentModel !== undefined ? { model: descriptor.agentModel } : {},
          ...descriptor.agentReasoningEffort !== undefined
            ? { reasoningEffort: ReasoningEffortId(descriptor.agentReasoningEffort) }
            : {},
        },
        composition: { agentPreset, persona: descriptor.persona, toolFilter: descriptor.toolFilter },
        signal: options.signal,
      })
    } catch (error: unknown) {
      options.signal.throwIfAborted()
      if (error instanceof SubagentError) throw error
      throw new SubagentError(`subagent "${childId}" is unavailable`, 'NOT_RESUMABLE', { cause: error })
    }
    return await this.submitMaterialized(activation, content, options, parent)
  }

  /** Admit a materialized child, commit its creation fact, and release it on failure. */
  private async submitMaterialized(
    activation: Activation,
    content: ContentBlock[],
    options: ChildDeliveryOptions,
    parent: Agent,
    commit?: () => void,
  ): Promise<MessageId> {
    try {
      if (contentHasImage(content)) {
        await this.assertImageCapable(activation.handle.agent, options.signal)
        if (activation.inbox.closing !== undefined) {
          throw new SubagentError(`subagent "${activation.childId}" is closing`, 'ACTIVATION_CLOSING')
        }
      }
      const messageId = await this.submitAdmitted(activation, content, options, parent)
      commit?.()
      activation.announced = true
      return messageId
    } catch (error: unknown) {
      try {
        await this.activations.dispose(activation)
      } catch (cleanupError: unknown) {
        this.ctx.logger.warn(
          `subagent continuation: disposal after admission or catalog append failure also failed: ${renderSubagentFailure(cleanupError)}`,
        )
      }
      throw error
    }
  }

  /** Attest human input before the final synchronous admission cutoff. */
  private async submitAdmitted(
    activation: Activation,
    content: ContentBlock[],
    options: ChildDeliveryOptions,
    parent: Agent,
  ): Promise<MessageId> {
    let message = options.message ?? (options.source === undefined
      ? createAgentMessage(parent, agentAddress(this.pathOf(parent, this.rootOf(parent)), parent.id), content)
      : createUserMessage({ content, source: options.source }))
    const authority = executionAuthorityOf(this.ctx)
    if (authority !== undefined && message.source.kind === 'user' && !('gatewayExecutionScope' in message.source)) {
      message = await authority.stamp(activation.handle.agent.session, message)
    }
    return this.activations.submitAdmitted(
      activation,
      message,
      options.delivery,
      parent,
      options.signal,
    )
  }

  /** Refuse image content when the child's resolved model is text-only. */
  private async assertImageCapable(agent: Agent, signal: AbortSignal): Promise<void> {
    const { provider, model } = agent.options
    if (provider === undefined || model === undefined) return
    const llm = this.ctx.get('llm')
    // A deployment without an LLM registry defers to its provider's own
    // content projection rather than inventing a second capability source.
    if (llm === undefined) return
    const info = await llm.resolveModelInfo(provider, model, signal)
    if (info.inputModalities !== undefined && !info.inputModalities.includes('image')) {
      throw new SubagentError(
        `Model "${model}" does not support image input.`,
        'MODEL_DOES_NOT_SUPPORT_IMAGES',
      )
    }
  }

  /** Resolve the persistence service continuable children require, or fail loud. */
  private requirePersistence(): SessionPersistence {
    const persistence = this.ctx.get('sessionPersistence')
    if (persistence === undefined) {
      throw new SubagentError(
        'continuable subagents require session persistence (load a dsh-session-persistence backend)',
        'PERSISTENCE_UNAVAILABLE',
      )
    }
    return persistence
  }
}

/**
 * Whether the child's own events record an independent `agentPreset` selection
 * before its first own descriptor — the marker that opts a child into
 * independent composition restoration.
 */
function hasIndependentPresetSelection(events: readonly SessionEvent[]): boolean {
  for (const event of events) {
    if (event.type === 'subagent/descriptor') return false
    if (event.type === 'agent-preset/selected') return true
  }
  /* v8 ignore next -- coldResume rejects logs without a supported own descriptor before this lookup. */
  return false
}

export default SubagentContinuationManager
