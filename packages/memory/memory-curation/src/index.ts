/**
 * `@deepseek-ai/dsh-memory-curation` — background memory curation. A
 * `session/event` listener folds per-turn state incrementally; on a completed
 * `turn/end` it queues one coalesced pass per session that may run an
 * extraction pass (review the finished conversation for durable facts) and a
 * consolidation pass (merge/deduplicate a whole scope) behind the `memory`
 * settings switches. Both run as auxiliary `purpose: 'memory'` model calls
 * with the session's own agent identity, source-stamped writers, and a
 * tool universe restricted to the four memory tools.
 * @module @deepseek-ai/dsh-memory-curation
 */

import { AsyncLocalStorage } from 'node:async_hooks'
import { createHash } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { executionAuthorityOf, sameExecutionAuthority, type ExecutionAuthority, type ExecutionInheritance } from '@deepseek-ai/dsh-execution-authority'
import {
  BlockAssembler,
  createToolResultMessage,
  deepFreeze,
  type ContentBlock,
  type GenerateOptions,
  type RequestMessage,
  type ToolCallBlock,
  type ToolSchema,
} from '@deepseek-ai/dsh-llm'
import type { Session, SessionEvent, SessionId, SessionSeq } from '@deepseek-ai/dsh-session'
import {
  MemoryRevision,
  memoryConsolidationCursorKey,
  memoryExtractionCursorKey,
  memoryScopeId,
  memorySignalWordCount,
  type MemoryEntry,
  type MemoryScope,
  type MemoryWriteResult,
  type MemoryWriter,
} from '@deepseek-ai/dsh-memory'
import { remoteErrorOf } from '@deepseek-ai/dsh-typert-protocol'
import { delegationDepthOf } from '@deepseek-ai/dsh-subagent'

export const name = 'memory-curation'
export const inject = ['memory']

/** Exact provider-neutral input for one extraction or consolidation round. */
export interface MemoryCurationRequestEventData {
  /** Curation pass that owns the request. */
  readonly kind: 'extraction' | 'consolidation'
  /** Zero-based model round within the pass. */
  readonly round: number
  /** Resolved input, excluding runtime-only cancellation and authorization. */
  readonly request: Omit<GenerateOptions, 'sessionId' | 'signal' | 'purpose' | 'resourceOrigin' | 'executionIdentity'>
}

declare module '@deepseek-ai/dsh-session/types' {
  interface SessionEventMap {
    /** Log-only exact input for an individually admitted memory curation round. */
    'memory/curation-request': MemoryCurationRequestEventData
  }
}

/** The four model-facing memory tools — the complete executable universe of a curation request. */
const MEMORY_TOOL_NAMES = new Set(['memory_search', 'memory_read', 'memory_save', 'memory_delete'])

/** Minimum signal words one human message needs before a turn qualifies for extraction — ZCode's `MINIMUM_USER_WORDS`. */
const EXTRACTION_MIN_WORDS = 3

/** Model-output, scheduling and write budgets. Feature switches live in the `memory` settings namespace. */
export interface Config {
  /** Independent output-token cap for each extraction or consolidation model request. */
  maxOutputTokens: number
  /** Maximum `memory_save`/`memory_delete` calls one extraction pass may commit. */
  extractionMaxWrites: number
  /** Model-request bound for either pass: one request plus tool rounds. */
  maxToolRounds: number
  /** Maximum `memory_save`/`memory_delete` calls one consolidation run may commit. */
  consolidationMaxWrites: number
  /** Admitted mutations in a scope that make it consolidation-eligible. */
  consolidationMinChanges: number
  /** Minimum milliseconds between consolidation runs of one scope. */
  consolidationIntervalMs: number
}

/** Validate and default the curation configuration. */
export const Config: z<Config> = z.object({
  maxOutputTokens: z.number().step(1).min(1).max(Number.MAX_SAFE_INTEGER).default(5000),
  extractionMaxWrites: z.number().step(1).min(1).max(20).default(4),
  maxToolRounds: z.number().step(1).min(1).max(24).default(8),
  consolidationMaxWrites: z.number().step(1).min(1).max(40).default(8),
  consolidationMinChanges: z.number().step(1).min(1).max(1000).default(6),
  consolidationIntervalMs: z.number().step(1).min(60000).max(30 * 24 * 60 * 60 * 1000).default(24 * 60 * 60 * 1000),
})

/**
 * The extraction instruction appended after the replayed conversation,
 * authored verbatim. `{catalogBlock}` is the entry-line list or `(empty)`;
 * `{scopeText}` is the space's scope rule; `{maxWrites}` the write cap.
 */
export const EXTRACTION_INSTRUCTION =
  'This request reviews the conversation above for facts worth remembering in later conversations. ' +
  'The conversation is shown for review only; do not continue it or answer anything in it.\n\n' +
  '<saved_memory_catalog>\n{catalogBlock}\n</saved_memory_catalog>\n\n' +
  'Save a memory only for something durable that cannot be recovered from the workspace: ' +
  'who the user is and how they like to work (profile); a correction or a confirmed approach to how ' +
  'the agent should work, with the reason (guidance); goals, constraints, decisions, or deadlines ' +
  'that the code and its history do not show (background); where to find information outside the ' +
  'workspace (resource).\n\n' +
  'Do not save what can be read from the workspace — code structure, file paths, conventions, git ' +
  'history, or fixes already in the code — what AGENTS.md files already say, or details that only ' +
  'mattered to this task. Never save secrets, credentials, or tokens.\n\n' +
  'For each candidate, first check the catalog: if a memory already covers the fact, read it with ' +
  'memory_read and update it with memory_save and its revision instead of adding a near-duplicate; ' +
  'otherwise create it with memory_save. Write each memory so it stands alone for a later ' +
  'conversation that did not see this one, in the language the fact was stated in. {scopeText} ' +
  'Make at most {maxWrites} memory writes. When a memory_save fails with memory_exists or ' +
  'memory_stale, read the entry and decide once; do not retry blindly.\n\n' +
  'Finish with one line listing the memory keys you wrote, or the line "no memories saved".'

/**
 * The consolidation instruction for one whole-scope review, authored verbatim.
 * `{scope}` is the scope kind; `{catalogBlock}` and `{maxWrites}` as above.
 */
export const CONSOLIDATION_INSTRUCTION =
  'This request consolidates the saved memories in the {scope} scope, listed below. ' +
  'It is not a conversation; do not address anyone.\n\n' +
  '<saved_memory_catalog>\n{catalogBlock}\n</saved_memory_catalog>\n\n' +
  'Work the list. Merge entries that state the same fact: keep the clearer key, update it with ' +
  'the merged content, and delete the others. Delete entries contradicted by a newer memory or ' +
  'that no longer hold. Convert relative dates in content to absolute dates. Prefer few edits ' +
  'over many, and keep each memory able to stand alone.\n\n' +
  'Use memory_read to check contents before changing or deleting an entry, then memory_save with ' +
  'its revision or memory_delete. Make at most {maxWrites} memory writes.\n\n' +
  'Finish with one line per action taken — "merged X+Y into X", "updated X", "deleted X" — or ' +
  'the line "no changes".'

/**
 * Per-turn facts folded from `session/event` as events commit — the
 * projectable state the deprecated synchronous history reads would give.
 */
interface TurnFold {
  /** The open turn number. */
  readonly turn: number
  /** A human-authored message carrying at least {@link EXTRACTION_MIN_WORDS} signal words committed inside this turn. */
  sawHuman: boolean
  /** A `memory_save`/`memory_delete` call already ran inside this turn. */
  sawMemoryWrite: boolean
}

/**
 * The session state captured at `turn/end` before any async work: the replay
 * prefix (derived surface messages, request-header tools, routed
 * provider/model) plus extraction eligibility and the cursor target seq.
 */
interface CapturedTurn {
  readonly agent: Agent
  /** Issuing provider and participants retained before the pass can queue. */
  readonly execution: { readonly authority: ExecutionAuthority; readonly scope: ExecutionInheritance } | undefined
  /** Sequence number of the closing `turn/end` — the extraction cursor target. */
  readonly endSeq: SessionSeq
  /** `session.deriveMessages()` at trigger time: system head plus surface history. */
  readonly messages: RequestMessage[]
  /** The request header's tools, replayed verbatim for the provider's prefix cache. */
  readonly tools: ToolSchema[] | undefined
  /** Routed provider/model of the session's last request (agent options as fallback). */
  readonly provider: string
  readonly model: string
  /** Tool history for route projection, matching the replayed request shape. */
  readonly toolHistory?: GenerateOptions['toolHistory']
  /** This turn contains human prose and has not already performed a memory write. */
  readonly extractionEligible: boolean
}

/** One queued pass — one running, at most one pending per session. */
interface Lane {
  /** Owns every pass this lane runs; session disposal or plugin unload aborts it. */
  readonly controller: AbortController
  /** Current extraction or consolidation owns settings cancellation through its cleanup. */
  pass: { readonly kind: CurationKind; readonly controller: AbortController } | undefined
  running: Promise<void> | undefined
  pending: CapturedTurn | undefined
}

/** Verified project authorization carried onto the auxiliary requests. */
type CurationIdentity = NonNullable<GenerateOptions['executionIdentity']>

/** Independently enabled auxiliary operations in one Session lane. */
type CurationKind = MemoryCurationRequestEventData['kind']

/** A completed read or prepared call no longer belongs to an enabled curation pass. */
class CurationUnavailableError extends Error {
  constructor() { super('Memory curation is unavailable for the current settings or scopes.') }
}

/** Whether the master switch and this operation's own switch both admit work. */
function curationEnabled(ctx: Context, kind: CurationKind): boolean {
  const switches = ctx.memory.switches()
  return switches.enabled && switches[kind]
}

/** Check current availability before dispatch, result publication or progress admission. */
function assertCurationAvailable(
  ctx: Context, captured: CapturedTurn, kind: CurationKind, scopes: readonly MemoryScope[], signal: AbortSignal,
): void {
  signal.throwIfAborted()
  assertExecutionAuthority(ctx, captured)
  const { agent } = captured
  const offered = new Set(ctx.memory.scopesFor(agent).map(memoryScopeId))
  if (scopes.some(scope => !offered.has(memoryScopeId(scope))) || !curationEnabled(ctx, kind)) throw new CurationUnavailableError()
}

/**
 * Register the `session/event` listener that folds turn state and drives
 * extraction/consolidation passes. Turn facts arrive with each committed
 * event, so `turn/end` never reads historical events; the replay prefix comes
 * from `deriveMessages()` and `requestHeader()`, both surface projections.
 * Settings cancel each operation independently; outstanding stream and storage
 * cleanup still belongs to its Session lane. Captured project authority is
 * rechecked at physical model dispatch and queued cursor admission.
 */
export function apply(ctx: Context, config: Config): void {
  const execution = new AsyncLocalStorage<CapturedTurn>()
  ctx.on('llm/pre-dispatch', async (options, next) => {
    const captured = execution.getStore()
    if (captured !== undefined) await authorizeCuration(ctx, captured, options.signal)
    await next()
  }, { global: true })

  const folds = new Map<SessionId, TurnFold>()
  const lanes = new Map<SessionId, Lane>()
  const active = new Set<Promise<void>>()
  /** A scope stays occupied through model cleanup and its conditional cursor commit. */
  const consolidations = new Set<string>()
  /** Sessions already warned that an enabled feature has no llm or tools service. */
  const warnedService = new WeakSet<object>()

  ctx.effect(() => {
    const releaseIdle = ctx.root.on('runtime/idle-release-check', () => active.size > 0 ? 'busy' : undefined, { global: true })
    return async () => {
      try {
        for (const lane of lanes.values()) lane.controller.abort()
        lanes.clear()
        await Promise.allSettled([...active])
        execution.disable()
      } finally { releaseIdle() }
    }
  })

  ctx.on('session/disposed', (session) => {
    folds.delete(session.id)
    lanes.get(session.id)?.controller.abort()
    lanes.delete(session.id)
  })

  ctx.on('memory/switches-updated', () => {
    for (const lane of lanes.values()) {
      const pass = lane.pass
      if (pass !== undefined && !curationEnabled(ctx, pass.kind)) pass.controller.abort(new CurationUnavailableError())
    }
  })

  ctx.on('session/event', (session, event) => {
    switch (event.type) {
      case 'turn/start':
        folds.set(session.id, { turn: event.data.turn, sawHuman: false, sawMemoryWrite: false })
        return
      case 'user/message': {
        const fold = folds.get(session.id)
        if (fold === undefined || fold.sawHuman || event.data.source.kind !== 'user') return
        const text = event.data.content
          .flatMap(block => (block.type === 'text' ? [block.text] : []))
          .join('\n')
        if (memorySignalWordCount(text) >= EXTRACTION_MIN_WORDS) fold.sawHuman = true
        return
      }
      case 'tool/call': {
        const fold = folds.get(session.id)
        if (fold !== undefined && (event.data.name === 'memory_save' || event.data.name === 'memory_delete')) {
          fold.sawMemoryWrite = true
        }
        return
      }
      case 'turn/end': {
        const fold = folds.get(session.id)
        folds.delete(session.id)
        if (event.data.reason.kind === 'completed') onTurnEnd(ctx, config, session, event, fold, lanes, active, warnedService, consolidations, execution)
        return
      }
      default:
        return
    }
  })
}

/** Derive, capture, and queue one pass for a completed turn. */
function onTurnEnd(
  ctx: Context,
  config: Config,
  session: Session,
  event: SessionEvent<'turn/end'>,
  fold: TurnFold | undefined,
  lanes: Map<SessionId, Lane>,
  active: Set<Promise<void>>,
  warnedService: WeakSet<object>,
  consolidations: Set<string>,
  execution: AsyncLocalStorage<CapturedTurn>,
): void {
  const switches = ctx.memory.switches()
  if (!switches.enabled || (!switches.extraction && !switches.consolidation)) return
  const agent = ctx.get('agents')?.get(session.id)
  if (agent === undefined) return
  if (delegationDepthOf(agent) > 0) return
  let captured: CapturedTurn | undefined
  try {
    captured = captureTurn(ctx, agent, event, fold)
  } catch (error: unknown) {
    ctx.logger.debug(`memory curation could not capture execution for session "${session.id}": ${String(error)}`)
    return
  }
  if (captured === undefined) {
    if (!warnedService.has(session)) {
      warnedService.add(session)
      ctx.logger.warn('memory curation is enabled but no provider/model is resolvable for the auxiliary call')
    }
    return
  }
  const lane = lanes.get(session.id) ?? { controller: new AbortController(), pass: undefined, running: undefined, pending: undefined }
  lanes.set(session.id, lane)
  if (lane.running !== undefined) {
    if (lane.pending?.extractionEligible !== true || captured.extractionEligible) lane.pending = captured
    return
  }
  const task = drive(ctx, config, lane, captured, lanes, warnedService, consolidations, execution)
  lane.running = task
  active.add(task)
  const untrack = (): void => { active.delete(task) }
  void task.then(untrack, untrack)
}

/** Snapshot the replay input synchronously inside the `turn/end` observation. */
function captureTurn(ctx: Context, agent: Agent, event: SessionEvent<'turn/end'>, fold: TurnFold | undefined): CapturedTurn | undefined {
  const session = agent.session
  const header = session.requestHeader()
  const provider = header?.config.provider ?? agent.options.provider
  const model = header?.config.model ?? agent.options.model
  if (provider === undefined || provider.length === 0 || model === undefined || model.length === 0) return undefined
  const authority = executionAuthorityOf(ctx)
  return {
    agent,
    execution: authority === undefined ? undefined : { authority, scope: authority.capture(agent) },
    endSeq: event.seq,
    messages: session.deriveMessages(),
    tools: header?.tools === undefined ? undefined : [...header.tools],
    provider,
    model,
    toolHistory: session.toolHistory(),
    extractionEligible: fold !== undefined && fold.sawHuman && !fold.sawMemoryWrite,
  }
}

/** Drain captured turns while retaining one owned task through cancellation and cleanup. */
async function drive(
  ctx: Context,
  config: Config,
  lane: Lane,
  captured: CapturedTurn,
  lanes: Map<SessionId, Lane>,
  warnedService: WeakSet<object>,
  consolidations: Set<string>,
  execution: AsyncLocalStorage<CapturedTurn>,
): Promise<void> {
  const sessionId = captured.agent.session.id
  try {
    let next: CapturedTurn | undefined = captured
    while (next !== undefined && !lane.controller.signal.aborted) {
      const current = next
      try {
        const authority = executionAuthorityOf(ctx)
        if (!sameExecutionAuthority(authority, current.execution?.authority)) {
          throw new Error('Memory curation execution authority was replaced.')
        }
        const work = () => execution.run(current, () => runPass(ctx, config, current, lane, warnedService, consolidations))
        if (current.execution === undefined) await work()
        else await current.execution.authority.runCaptured(current.agent, current.execution.scope, work)
      } catch (error: unknown) {
        ctx.logger.debug(`memory curation pass for session "${sessionId}" failed: ${String(error)}`)
      }
      next = lane.pending
      lane.pending = undefined
    }
  } finally {
    lane.running = undefined
    if (lanes.get(sessionId) === lane) lanes.delete(sessionId)
  }
}

/**
 * Extraction and consolidation retain independent settings cancellation while
 * sharing the Session lane's disposal lifetime and coalesced turn queue.
 */
async function runPass(
  ctx: Context,
  config: Config,
  captured: CapturedTurn,
  lane: Lane,
  warnedService: WeakSet<object>,
  consolidations: Set<string>,
): Promise<void> {
  const run = async (kind: CurationKind, work: (signal: AbortSignal) => Promise<void>): Promise<void> => {
    if (lane.controller.signal.aborted || !curationEnabled(ctx, kind)) return
    const controller = new AbortController()
    lane.pass = { kind, controller }
    const signal = AbortSignal.any([lane.controller.signal, controller.signal])
    try {
      await work(signal)
    } catch (error: unknown) {
      if (!(error instanceof CurationUnavailableError) && !controller.signal.aborted) throw error
      ctx.logger.debug(`memory ${kind} stopped: ${String(error)}`)
    } finally {
      lane.pass = undefined
    }
  }
  if (captured.extractionEligible) await run('extraction', signal => runExtraction(ctx, config, captured, signal, warnedService))
  await run('consolidation', signal => runConsolidations(ctx, config, captured, signal, warnedService, consolidations))
}

/**
 * The extraction pass: replay the captured prefix, append the instruction,
 * and run the bounded tool loop with an `extraction` writer. The durable
 * cursor advances only after the loop completes, so an interrupted pass
 * reviews the same slice next time.
 */
async function runExtraction(
  ctx: Context,
  config: Config,
  captured: CapturedTurn,
  signal: AbortSignal,
  warnedService: WeakSet<object>,
): Promise<void> {
  const { agent } = captured
  const cursorKey = memoryExtractionCursorKey(agent.session.id)
  const cursor = await ctx.memory.getCursor(cursorKey)
  if (cursor?.lastSeq !== undefined && cursor.lastSeq >= captured.endSeq) return

  const scopes = ctx.memory.scopesFor(agent)
  if (scopes.length === 0) return
  assertCurationAvailable(ctx, captured, 'extraction', scopes, signal)

  // Authorize before the first model call in project space; denial skips
  // quietly so no write path opens. Personal space needs no authority.
  const identity = ctx.memory.space === 'project'
    ? await authorizeMemory(ctx, captured, signal)
    : undefined
  if (identity === 'denied') return

  const llm = ctx.get('llm')
  if (llm === undefined) {
    warnOnce(ctx, agent.session, warnedService, 'memory curation is enabled but no llm service is present')
    return
  }

  const catalog = await catalogBlock(ctx, scopes, signal)
  assertCurationAvailable(ctx, captured, 'extraction', scopes, signal)
  const scopeText = ctx.memory.space === 'project'
    ? 'Use the project scope.'
    : 'Use the personal scope for facts about the user that apply in every workspace, and the workspace scope for facts specific to the working directory the conversation ran in.'
  const instruction = EXTRACTION_INSTRUCTION
    .replace('{catalogBlock}', catalog)
    .replace('{scopeText}', scopeText)
    .replace('{maxWrites}', String(config.extractionMaxWrites))

  await runMemoryLoop(ctx, captured, llm, {
    provider: captured.provider,
    model: captured.model,
    messages: [...captured.messages, { role: 'user', content: [{ type: 'text', text: instruction }] }],
    tools: captured.tools,
    toolHistory: captured.toolHistory,
    sessionId: agent.session.id,
    scopes,
    signal,
    maxOutputTokens: config.maxOutputTokens,
    maxWrites: config.extractionMaxWrites,
    maxRounds: config.maxToolRounds,
    writerSource: 'extraction',
    executionIdentity: identity,
  })
  assertCurationAvailable(ctx, captured, 'extraction', scopes, signal)
  await ctx.memory.writeCursor(cursorKey, { lastSeq: captured.endSeq }, signal, async () => {
    await authorizeCuration(ctx, captured, signal)
    return () => { assertCurationAvailable(ctx, captured, 'extraction', scopes, signal) }
  })
}

/**
 * Evaluate every scope the session may address against the consolidation
 * gates — elapsed interval, admitted-mutation threshold, and content digest —
 * and run a whole-scope pass for each that qualifies.
 */
async function runConsolidations(
  ctx: Context,
  config: Config,
  captured: CapturedTurn,
  signal: AbortSignal,
  warnedService: WeakSet<object>,
  consolidations: Set<string>,
): Promise<void> {
  const { agent } = captured
  for (const scope of ctx.memory.scopesFor(agent)) {
    assertCurationAvailable(ctx, captured, 'consolidation', [scope], signal)
    const key = memoryScopeId(scope)
    if (consolidations.has(key)) continue
    consolidations.add(key)
    try {
      const llm = ctx.get('llm')
      const toolSchemas = ctx.get('tools')?.schemas(agent).filter(schema => MEMORY_TOOL_NAMES.has(schema.name))
      await maybeConsolidateScope(ctx, config, captured, scope, llm, toolSchemas, signal, warnedService)
    } finally {
      consolidations.delete(key)
    }
  }
}

/** Gate and run one scope's consolidation pass, then commit its cursor. */
async function maybeConsolidateScope(
  ctx: Context,
  config: Config,
  captured: CapturedTurn,
  scope: MemoryScope,
  llm: Context['llm'] | undefined,
  toolSchemas: ToolSchema[] | undefined,
  signal: AbortSignal,
  warnedService: WeakSet<object>,
): Promise<void> {
  const { agent } = captured
  const cursorKey = memoryConsolidationCursorKey(scope)
  const cursor = await ctx.memory.getCursor(cursorKey)
  assertCurationAvailable(ctx, captured, 'consolidation', [scope], signal)
  if (cursor?.lastRunAt !== undefined && Date.now() - Date.parse(cursor.lastRunAt) < config.consolidationIntervalMs) return
  const changedSince = cursor?.changedSince ?? 0
  if (changedSince < config.consolidationMinChanges) return
  const before = await ctx.memory.entries(scope)
  assertCurationAvailable(ctx, captured, 'consolidation', [scope], signal)
  if (contentDigest(before) === cursor?.lastDigest) return
  if (before.length === 0) {
    // Empty reviews still require their captured project authorization.
    await ctx.memory.writeCursorIfUnchanged(cursorKey, cursor, {
      lastRunAt: new Date().toISOString(),
      lastDigest: contentDigest(before),
      changedSince: 0,
    }, signal, async () => {
      await authorizeCuration(ctx, captured, signal)
      return () => { assertCurationAvailable(ctx, captured, 'consolidation', [scope], signal) }
    })
    return
  }
  const identity = scope.kind === 'project' ? await authorizeMemory(ctx, captured, signal) : undefined
  if (identity === 'denied') return
  if (llm === undefined) {
    warnOnce(ctx, agent.session, warnedService, 'memory curation is enabled but no llm service is present')
    return
  }
  if (toolSchemas === undefined) {
    warnOnce(ctx, agent.session, warnedService, 'memory curation is enabled but no tools service is present')
    return
  }
  const target = routedTarget(agent)
  if (target === undefined) {
    warnOnce(ctx, agent.session, warnedService, 'memory curation is enabled but no provider/model is resolvable for the auxiliary call')
    return
  }
  const instruction = CONSOLIDATION_INSTRUCTION
    .replace('{scope}', scope.kind)
    .replace('{catalogBlock}', before.map(catalogLine).join('\n'))
    .replace('{maxWrites}', String(config.consolidationMaxWrites))
  const { writes } = await runMemoryLoop(ctx, captured, llm, {
    provider: target.provider,
    model: target.model,
    messages: [{ role: 'user', content: [{ type: 'text', text: instruction }] }],
    tools: toolSchemas,
    sessionId: agent.session.id,
    scopes: [scope],
    signal,
    maxOutputTokens: config.maxOutputTokens,
    maxWrites: config.consolidationMaxWrites,
    maxRounds: config.maxToolRounds,
    writerSource: 'consolidation',
    executionIdentity: identity,
  })
  assertCurationAvailable(ctx, captured, 'consolidation', [scope], signal)
  const after = await ctx.memory.entries(scope)
  assertCurationAvailable(ctx, captured, 'consolidation', [scope], signal)
  await ctx.memory.writeCursorIfUnchanged(cursorKey, {
    ...cursor,
    changedSince: changedSince + writes,
  }, {
    lastRunAt: new Date().toISOString(),
    lastDigest: contentDigest(after),
    changedSince: 0,
  }, signal, async () => {
    await authorizeCuration(ctx, captured, signal)
    return () => { assertCurationAvailable(ctx, captured, 'consolidation', [scope], signal) }
  })
}

/** Refuse an inherited pass after its issuing service has been removed or replaced. */
function assertExecutionAuthority(ctx: Context, captured: CapturedTurn): void {
  if (!sameExecutionAuthority(executionAuthorityOf(ctx), captured.execution?.authority)) {
    throw new Error('Memory curation execution authority was replaced.')
  }
}

/** Recheck project qualification under the captured participants without lending another issuer's identity. */
async function authorizeCuration(
  ctx: Context, captured: CapturedTurn, signal: AbortSignal | undefined,
): Promise<CurationIdentity | undefined> {
  signal?.throwIfAborted()
  assertExecutionAuthority(ctx, captured)
  const state = ctx.memory.space === 'project'
    ? await captured.execution?.authority.authorize('memory', captured.agent, signal)
    : undefined
  assertExecutionAuthority(ctx, captured)
  signal?.throwIfAborted()
  if (state === undefined) return undefined
  return { inputs: state.inputs, ...(state.primaryActorUserId === undefined ? {} : { primaryActorUserId: state.primaryActorUserId }) }
}

/** Initial project denial skips the pass before catalog assembly. */
async function authorizeMemory(
  ctx: Context, captured: CapturedTurn, signal: AbortSignal,
): Promise<CurationIdentity | 'denied' | undefined> {
  try { return await authorizeCuration(ctx, captured, signal) }
  catch (error: unknown) {
    ctx.logger.debug(`memory curation authorization denied: ${String(error)}`)
    return 'denied'
  }
}

/** The bounded model-plus-tool-call loop shared by extraction and consolidation. */
interface MemoryLoopOptions {
  readonly provider: string
  readonly model: string
  readonly messages: RequestMessage[]
  readonly tools?: ToolSchema[] | undefined
  readonly toolHistory?: GenerateOptions['toolHistory'] | undefined
  readonly sessionId: SessionId
  /** Extraction's offered scopes or consolidation's single selected scope. */
  readonly scopes: readonly MemoryScope[]
  readonly signal: AbortSignal
  readonly maxOutputTokens: number
  readonly maxWrites: number
  readonly maxRounds: number
  readonly writerSource: 'extraction' | 'consolidation'
  readonly executionIdentity?: CurationIdentity | undefined
}

/**
 * Run the restricted tool loop: stream one request, execute only the four
 * memory tools against `ctx.memory` with the source-stamped writer, and
 * feed tool results back until the model stops calling tools, the write cap
 * is spent, or the round bound trips. A call to anything outside the memory
 * tool set returns an error result to the model. Each round logs its resolved
 * request before dispatch and retains the triggering Session's resource origin.
 */
async function runMemoryLoop(
  ctx: Context,
  captured: CapturedTurn,
  llm: NonNullable<Context['llm']>,
  options: MemoryLoopOptions,
): Promise<{ writes: number; text: string }> {
  const { agent } = captured
  const writer: MemoryWriter = { kind: 'agent', agent, signal: options.signal, source: options.writerSource }
  const messages: RequestMessage[] = [...options.messages]
  const checkAvailable = (): void => { assertCurationAvailable(ctx, captured, options.writerSource, options.scopes, options.signal) }
  checkAvailable()
  // Auxiliary passes ride the model's lowest advertised reasoning effort and
  // a capped output budget; a failed metadata lookup only drops the hint.
  let reasoningEffort: GenerateOptions['reasoningEffort']
  try {
    reasoningEffort = (await llm.resolveModelInfo(options.provider, options.model, options.signal)).reasoning?.efforts[0]?.id
  } catch (error: unknown) {
    ctx.logger.debug(`memory curation effort lookup failed: ${String(error)}`)
  }
  let writes = 0
  for (let round = 0; round < options.maxRounds; round += 1) {
    checkAvailable()
    const assembler = new BlockAssembler()
    const call = await llm.prepareCall({
      provider: options.provider,
      model: options.model,
      maxTokens: options.maxOutputTokens,
      ...(reasoningEffort === undefined ? {} : { reasoningEffort }),
    }, options.signal)
    checkAvailable()
    const request: MemoryCurationRequestEventData['request'] = deepFreeze({
      ...call.config,
      messages: [...messages],
      ...(options.tools === undefined ? {} : { tools: options.tools }),
      ...(options.toolHistory === undefined ? {} : { toolHistory: options.toolHistory }),
    })
    options.signal.throwIfAborted()
    await authorizeCuration(ctx, captured, options.signal)
    checkAvailable()
    agent.session.append('memory/curation-request', { kind: options.writerSource, round, request })
    for await (const chunk of call.stream({
      ...request,
      sessionId: options.sessionId,
      signal: options.signal,
      purpose: 'memory',
      resourceOrigin: 'execution',
      ...(options.executionIdentity === undefined ? {} : { executionIdentity: options.executionIdentity }),
    })) assembler.push(chunk)
    const finish = assembler.finish
    if (finish.kind === 'error' || finish.kind === 'aborted') {
      throw new Error(`memory curation request ${finish.kind}: ${finish.failure.message}`)
    }
    checkAvailable()
    await authorizeCuration(ctx, captured, options.signal)
    checkAvailable()
    const blocks = assembler.blocks()
    const calls = blocks.filter((block): block is ToolCallBlock => block.type === 'tool-call')
    if (calls.length === 0) {
      return { writes, text: blocks.flatMap(block => (block.type === 'text' ? [block.text] : [])).join('') }
    }
    messages.push(assembler.message({ provider: options.provider, model: options.model }))
    for (const call of calls) {
      checkAvailable()
      const outcome = await executeMemoryCall(ctx, agent, call, writer, options.scopes, options.maxWrites - writes)
      if (outcome.wrote) writes += 1
      checkAvailable()
      messages.push(createToolResultMessage({ callId: call.id, content: outcome.content, isError: outcome.isError }))
    }
  }
  return { writes, text: '' }
}

/** One executed call: model-facing result blocks plus whether it committed a write. */
interface CallOutcome {
  readonly content: ContentBlock[]
  readonly isError: boolean
  readonly wrote: boolean
}

/** Error-result shorthand. */
function fail(text: string): CallOutcome {
  return { content: [{ type: 'text', text }], isError: true, wrote: false }
}

/** Success-result shorthand. */
function succeed(text: string, wrote = false): CallOutcome {
  return { content: [{ type: 'text', text }], isError: false, wrote }
}

/**
 * Dispatch one tool call against `ctx.memory`. Only the four memory tools
 * execute; `memory_save`/`memory_delete` count against `writesLeft` and route
 * through the same serialized service writes the model tools use, carrying
 * the pass's writer source.
 */
async function executeMemoryCall(
  ctx: Context,
  agent: Agent,
  call: ToolCallBlock,
  writer: MemoryWriter,
  allowedScopes: readonly MemoryScope[],
  writesLeft: number,
): Promise<CallOutcome> {
  if (!MEMORY_TOOL_NAMES.has(call.name)) {
    return fail(`Tool "${call.name}" is not available in this request; only the memory tools may be used.`)
  }
  let args: unknown
  try {
    args = JSON.parse(call.arguments.length === 0 ? '{}' : call.arguments)
  } catch {
    return fail('The memory tool call has invalid JSON arguments.')
  }
  if (typeof args !== 'object' || args === null || Array.isArray(args)) {
    return fail('The memory tool call arguments must be a JSON object.')
  }
  const input = args as Record<string, unknown>
  const twoScopes = ctx.memory.space === 'personal'
  const currentScopes = ctx.memory.scopesFor(agent)
  const allowedIds = new Set(allowedScopes.map(scope => memoryScopeId(scope)))
  const scopes = currentScopes.filter(scope => allowedIds.has(memoryScopeId(scope)))
  const suffix = (kind: string | undefined): string => (twoScopes && kind !== undefined ? ` in the ${kind} scope` : '')
  const resolve = (): { scope: MemoryScope } | { error: CallOutcome } => {
    const kind = input.scope === undefined ? scopes[0]?.kind : input.scope
    const scope = scopes.find(candidate => candidate.kind === kind)
    if (scope !== undefined) return { scope }
    if (kind === 'workspace' && ctx.memory.switches().enabled && !currentScopes.some(candidate => candidate.kind === 'workspace')) {
      return { error: fail('This conversation has no working directory, so the workspace scope is unavailable.') }
    }
    return { error: fail('The requested memory scope is unavailable in this request.') }
  }

  switch (call.name) {
    case 'memory_search': {
      if (typeof input.query !== 'string') return fail('memory_search requires a string "query".')
      let searchScopes: readonly MemoryScope[]
      if (input.scope === undefined) {
        searchScopes = scopes
      } else {
        const resolved = resolve()
        if ('error' in resolved) return resolved.error
        searchScopes = [resolved.scope]
      }
      const result = await ctx.memory.search(searchScopes, input.query)
      if (!Array.isArray(result)) return fail('memory_invalid: The query must contain at least one word.')
      if (result.length === 0) return succeed(`No saved memory matches "${input.query}".`)
      const lines = result.flatMap(hit => [
        `- \`${hit.entry.key}\`${twoScopes ? ` (${hit.entry.scope.kind})` : ''} [${hit.entry.kind}, ${hit.entry.updated.at.slice(0, 10)}]: ${escapeXml(hit.entry.summary)}`,
        `  ${escapeXml(hit.excerpt)}`,
      ])
      return succeed([`<memory_search query="${escapeXml(input.query)}">`, ...lines, '</memory_search>'].join('\n'))
    }
    case 'memory_read': {
      if (typeof input.key !== 'string') return fail('memory_read requires a string "key".')
      const resolved = resolve()
      if ('error' in resolved) return resolved.error
      const entry = await ctx.memory.read(resolved.scope, input.key)
      if (entry === undefined) return fail(`memory_not_found: No saved memory has the key "${input.key}"${suffix(resolved.scope.kind)}.`)
      return succeed([
        `<memory key="${entry.key}"${twoScopes ? ` scope="${entry.scope.kind}"` : ''} kind="${entry.kind}" updated="${entry.updated.at.slice(0, 10)}" revision="${entry.revision}">`,
        entry.content,
        '</memory>',
      ].join('\n'))
    }
    case 'memory_save': {
      if (writesLeft <= 0) return fail('The write budget for this request is exhausted; make no more changes.')
      if (typeof input.key !== 'string' || typeof input.summary !== 'string' || typeof input.content !== 'string') {
        return fail('memory_save requires string "key", "summary", and "content".')
      }
      const resolved = resolve()
      if ('error' in resolved) return resolved.error
      const kind = input.kind
      if (kind !== 'profile' && kind !== 'guidance' && kind !== 'background' && kind !== 'resource') {
        return fail('memory_invalid: "kind" must be one of profile, guidance, background, resource.')
      }
      const fields = input as { key: string; summary: string; content: string }
      const result = await writeCall(() => ctx.memory.save({
        scope: resolved.scope,
        key: fields.key,
        kind,
        summary: fields.summary,
        content: fields.content,
        ...(typeof input.revision === 'string' ? { expectedRevision: MemoryRevision(input.revision) } : {}),
      }, writer))
      if ('error' in result) return result.error
      if (!result.ok) return fail(refusalText(result, fields.key, resolved.scope, suffix))
      const entry = result.entry
      return succeed(`${result.operation === 'create' ? 'Created' : 'Updated'} memory "${entry.key}"${suffix(resolved.scope.kind)} (revision ${entry.revision}).`, true)
    }
    case 'memory_delete': {
      if (writesLeft <= 0) return fail('The write budget for this request is exhausted; make no more changes.')
      if (typeof input.key !== 'string') return fail('memory_delete requires a string "key".')
      const key = input.key
      const resolved = resolve()
      if ('error' in resolved) return resolved.error
      const result = await writeCall(() => ctx.memory.delete({
        scope: resolved.scope,
        key,
        ...(typeof input.revision === 'string' ? { expectedRevision: MemoryRevision(input.revision) } : {}),
      }, writer))
      if ('error' in result) return result.error
      if (!result.ok) return fail(refusalText(result, key, resolved.scope, suffix))
      return succeed(`Deleted memory "${result.entry.key}"${suffix(resolved.scope.kind)}.`, true)
    }
    /* v8 ignore next -- the MEMORY_TOOL_NAMES guard above already refused non-memory calls. */
    default:
      return fail(`Tool "${call.name}" is not available in this request; only the memory tools may be used.`)
  }
}

/**
 * Run one service write; a project-authority denial surfaces as an error
 * result with the model-facing refusal text rather than a thrown RemoteError.
 */
async function writeCall(
  write: () => Promise<MemoryWriteResult>,
): Promise<MemoryWriteResult | { error: CallOutcome }> {
  try {
    return await write()
  } catch (error: unknown) {
    if (remoteErrorOf(error)?.code === 'execution/forbidden') {
      return {
        error: fail(
          'execution_forbidden: Changing project memory is not permitted in this conversation. ' +
          'An administrator must enable memory writing for this project and for every participant, ' +
          'and private conversations can only read project memory.',
        ),
      }
    }
    throw error
  }
}

/** Render a write refusal for the model, code-prefixed to match the prompt vocabulary. */
function refusalText(
  result: MemoryWriteResult & { ok: false },
  key: string,
  scope: MemoryScope,
  suffix: (kind: string | undefined) => string,
): string {
  const placed = suffix(scope.kind)
  switch (result.code) {
    case 'memory_exists':
      return `memory_exists: A memory with the key "${key}" already exists${placed}. Read it with memory_read and pass its revision to replace it, or choose another key.`
    case 'memory_not_found':
      return `memory_not_found: No saved memory has the key "${key}"${placed}.`
    case 'memory_stale':
      return `memory_stale: The memory "${key}" changed after the revision you read. Read it again with memory_read before changing it.`
    case 'memory_full':
      return 'memory_full: This memory scope already holds its maximum number of memories. Delete or merge memories that are no longer useful before saving a new one.'
    case 'memory_invalid': {
      /* v8 ignore next -- the `? ''` arm is defensive: every service `memory_invalid` carries a reason. */
      const reason = result.reason === undefined ? '' : ` (${result.reason})`
      return `memory_invalid: The memory request was invalid${reason}.`
    }
    /* v8 ignore next -- MemoryRefusalCode is a closed union; every case above returns. */
    default:
      return 'The memory write was refused.'
  }
}

/** One catalog line in the shared `` `key` [kind, date]: summary `` format. */
function catalogLine(entry: MemoryEntry): string {
  return `- \`${entry.key}\` [${entry.kind}, ${entry.updated.at.slice(0, 10)}]: ${escapeXml(entry.summary)}`
}

/** The `{catalogBlock}` content for a set of scopes: entry lines or `(empty)`. */
async function catalogBlock(ctx: Context, scopes: readonly MemoryScope[], signal: AbortSignal): Promise<string> {
  const lines: string[] = []
  for (const scope of scopes) {
    signal.throwIfAborted()
    for (const entry of await ctx.memory.entries(scope)) {
      lines.push(catalogLine(entry))
    }
  }
  return lines.length === 0 ? '(empty)' : lines.join('\n')
}

/** Content-hash dedupe input: key+summary+content tuples in a stable key order. */
function contentDigest(entries: readonly MemoryEntry[]): string {
  const canonical = entries
    .map(entry => JSON.stringify([entry.key, entry.summary, entry.content]))
    .sort()
    .join('\n')
  return createHash('sha256').update(canonical).digest('hex')
}

/** The session's routed provider/model, else the agent's configured options; `undefined` when neither resolves. */
function routedTarget(agent: Agent): { provider: string; model: string } | undefined {
  const header = agent.session.requestHeader()?.config
  const provider = header?.provider ?? agent.options.provider
  const model = header?.model ?? agent.options.model
  if (provider === undefined || provider.length === 0 || model === undefined || model.length === 0) return undefined
  return { provider, model }
}

/** Log a service-availability warning once per session. */
function warnOnce(ctx: Context, session: Session, warned: WeakSet<object>, message: string): void {
  if (warned.has(session)) return
  warned.add(session)
  ctx.logger.warn(message)
}

/** The catalog/search pseudo-XML escaping — never applied to stored facts. */
function escapeXml(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
}
