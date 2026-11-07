/**
 * Profile-named Codex one-shot subagent provider. Every accepted run starts a
 * fresh official package-local Codex wrapper with `app-server --stdio` in the
 * delegating Session's workspace and publishes only after an ephemeral thread exists.
 *
 * @module @deepseek-ai/dsh-subagent-codex
 */

import { homedir } from 'node:os'
import { join } from 'node:path'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type { Context } from '@deepseek-ai/cordis'
import type { SshConnection } from '@deepseek-ai/dsh-ssh'
import { SENSITIVE_ENV_PATTERN } from '@deepseek-ai/dsh-subprocess'
import z from '@deepseek-ai/schemastery'
import { MAX_TIMER_DELAY_MS } from '@deepseek-ai/dsh-timeout'
import {
  assertPositiveFinite,
  assertExternalModelExecution,
  requiresParentModelControl,
  NO_START_CAPABILITIES,
  resolveChildExecution,
  externalMemberAgent,
  SubagentError,
  type ChildExecution,
  type ContinuableCreateRequest,
  type ContinuableCreateSpec,
  type ResolvedSubagentStartRequest,
  type SubagentCapabilities,
  type SubagentProvider,
} from '@deepseek-ai/dsh-subagent'
import { ExternalBindingStore, externalMemberIdentity, type ExternalModelSelection } from '@deepseek-ai/dsh-subagent/external'
import {
  CODEX_PERMISSION_MODES,
  DEFAULT_CODEX_PERMISSION_MODE,
  DEFAULT_DISPOSE_GRACE_MS,
  codexStartupFailure,
  startCodexRun,
  type CodexPermissionMode,
  type CodexRunSpec,
} from './run.ts'
import {
  CODEX_MEMBER_MODEL,
  CODEX_MEMBER_ROUTE,
  CodexMemberAdapter,
  CodexMemberTransport,
  type CodexMemberConfig,
} from './member.ts'
import { startManagedCodexModel, type ManagedCodexModel } from './managed-model.ts'
export type { CodexModelRequest } from './model-request-event.ts'

export const name = 'subagent-codex'
export const inject = ['subagents', 'subprocess']

const DEFAULT_PROVIDER_NAME = 'codex'
const DEFAULT_MODEL_REQUEST_BYTES = 8 * 1024 * 1024
const DEFAULT_MODEL_RESPONSE_BYTES = 64 * 1024 * 1024
const DEFAULT_MODEL_REQUEST_TIMEOUT_MS = 120_000
const DEFAULT_MODEL_PENDING_REQUESTS = 32

/** Deployment-owned model, permission, environment, and process-release settings. */
export interface Config {
  /** Provider name on `ctx.subagents` (default `codex`). */
  providerName?: string
  /** Upstream managed model, or native Codex model in independent compositions; omission inherits the selected route. */
  model?: string
  /** Registered Responses route; managed members otherwise capture the initiating parent's selected route. */
  modelProvider?: string
  /** Largest native model request accepted by the parent relay, in bytes. */
  modelRequestBytes?: number
  /** Largest native model response accepted by the parent transport, in bytes. */
  modelResponseBytes?: number
  /** Deadline for receiving the child’s HTTP request body. */
  modelRequestTimeoutMs?: number
  /** Maximum simultaneous native HTTP connections and pending requests per run. */
  modelPendingRequests?: number
  /**
   * Explicit environment entries layered over the subprocess seam's
   * credential-scrubbed parent environment.
   */
  env?: Record<string, string>
  /** Native non-interactive permission mode fixed for this Provider instance. */
  permissionMode?: CodexPermissionMode
  /** Grace in milliseconds between app-server managed-range termination tiers. */
  disposeGraceMs?: number
  /**
   * Directory holding the instance-specific member binding store (default `codex.jsonl`),
   * which maps each durable child session to its Codex thread id and pending
   * prompt. Required only for continuable members; defaults under `~/.dsh`.
   */
  stateDir?: string
  /**
   * Workspace override for persistent members; omitted uses the member Session working directory.
   */
  memberCwd?: string
  /** Preinstalled command resolved inside an SSH execution target. */
  remoteCommand?: string
}

export const Config: z<Config> = z.object({
  providerName: z.string().min(1).default(DEFAULT_PROVIDER_NAME),
  model: z.string().min(1),
  modelProvider: z.string().min(1),
  modelRequestBytes: z.number().step(1).min(1).max(Number.MAX_SAFE_INTEGER).default(DEFAULT_MODEL_REQUEST_BYTES),
  modelResponseBytes: z.number().step(1).min(1).max(Number.MAX_SAFE_INTEGER).default(DEFAULT_MODEL_RESPONSE_BYTES),
  modelRequestTimeoutMs: z.number().step(1).min(1).max(MAX_TIMER_DELAY_MS).default(DEFAULT_MODEL_REQUEST_TIMEOUT_MS),
  modelPendingRequests: z.number().step(1).min(1).max(Number.MAX_SAFE_INTEGER).default(DEFAULT_MODEL_PENDING_REQUESTS),
  env: z.dict(z.string()).default({}),
  permissionMode: z.union([...CODEX_PERMISSION_MODES])
    .default(DEFAULT_CODEX_PERMISSION_MODE),
  disposeGraceMs: z.number().default(DEFAULT_DISPOSE_GRACE_MS),
  stateDir: z.string().min(1),
  memberCwd: z.string().min(1),
  remoteCommand: z.string().min(1).default('codex'),
})

type ResolvedConfig = Omit<Required<Config>, 'model' | 'modelProvider' | 'stateDir' | 'memberCwd'>
  & Pick<Config, 'model' | 'modelProvider' | 'stateDir' | 'memberCwd'>

async function managedForward(
  ctx: Context, parent: ResolvedSubagentStartRequest['parent'], execution: ChildExecution,
): Promise<SshConnection['forwardLoopback'] | undefined> {
  if (!execution.remote) return undefined
  const { environmentForAgent } = await import('@deepseek-ai/dsh-agent-preset-registry')
  const ssh = environmentForAgent(ctx, parent, 'ssh')
  if (ssh === undefined) throw new SubagentError('Managed Codex requires the initiating Agent’s SSH connection.', 'UNSUPPORTED_CAPABILITY')
  await ssh.ready
  return ssh.forwardLoopback.bind(ssh)
}

class CodexProvider implements SubagentProvider {
  readonly capabilities: SubagentCapabilities = NO_START_CAPABILITIES
  readonly inheritsParentContext = false
  readonly agentRouteDefaults?: Readonly<{ provider: string; model: string }>
  readonly name: string
  private readonly ctx: Context
  private readonly config: ResolvedConfig
  private readonly memberStore: ExternalBindingStore | undefined

  constructor(
    name: string,
    ctx: Context,
    config: ResolvedConfig,
    memberRoute: string | undefined,
    memberStore: ExternalBindingStore | undefined,
  ) {
    this.name = name
    this.ctx = ctx
    this.config = config
    this.memberStore = memberStore
    if (memberRoute !== undefined) {
      this.agentRouteDefaults = {
        provider: memberRoute,
        model: config.model ?? CODEX_MEMBER_MODEL,
      }
      this.prepareContinuable = async (request: ContinuableCreateRequest) => {
        const selection = resolveModel(ctx, request.parent, config, memberStore)
        const execution = await resolveChildExecution(ctx, request.parent, config.memberCwd ?? request.cwd, request.signal)
        if (selection.mode === 'managed') await managedForward(ctx, request.parent, execution)
        if (execution.remote) await execution.subprocess.resolveExecutable(config.remoteCommand, config.env, request.signal)
        request.signal.throwIfAborted()
        memberStore?.selectModel(request.sessionId, selection)
        return {}
      }
    }
  }

  declare prepareContinuable?: (
    request: ContinuableCreateRequest,
  ) => Promise<ContinuableCreateSpec>

  async start(request: ResolvedSubagentStartRequest) {
    const selection = resolveModel(this.ctx, request.parent, this.config, this.memberStore)
    const managedRoute = selection.mode === 'managed' ? selection : undefined
    let execution: ChildExecution
    try {
      execution = await resolveChildExecution(this.ctx, request.parent, request.cwd, request.signal)
    } catch (error: unknown) {
      if (request.signal.aborted) {
        throw new Error(
          'subagent-codex: request was aborted before app-server startup',
        )
      }
      throw codexStartupFailure(error)
    }
    const forward = managedRoute === undefined ? undefined : await managedForward(this.ctx, request.parent, execution)
    const executable = execution.remote
      ? await execution.subprocess.resolveExecutable(this.config.remoteCommand, this.config.env, request.signal) : undefined
    let modelOwner: ManagedCodexModel | undefined
    if (managedRoute !== undefined) {
      modelOwner = await startManagedCodexModel(this.ctx, request.parent, {
        ...managedRoute, maxRequestBytes: this.config.modelRequestBytes,
        maxResponseBytes: this.config.modelResponseBytes, requestTimeoutMs: this.config.modelRequestTimeoutMs,
        maxPendingRequests: this.config.modelPendingRequests,
      }, request.signal, forward)
    }
    const spec: CodexRunSpec = {
      cwd: execution.cwd,
      ...executable === undefined ? {} : { executable },
      ...modelOwner !== undefined ? { model: modelOwner.model, nativeConfig: modelOwner.config }
        : this.config.model === undefined ? {} : { model: this.config.model },
      permissionMode: this.config.permissionMode,
      env: modelOwner === undefined ? this.config.env : {
        ...Object.fromEntries(Object.entries(this.config.env).filter(([key]) => !SENSITIVE_ENV_PATTERN.test(key))),
        ...modelOwner.env,
      },
      disposeGraceMs: this.config.disposeGraceMs,
      spawn: spawnSpec => execution.subprocess.spawn({ ...spawnSpec, sessionId: request.parent.id, resourceOrigin: 'execution' }),
      onError: (error, stopReason) => {
        this.ctx.logger.warn(
          `subagent-codex "${this.name}": child run failed (${stopReason}): ${error.message}`,
        )
      },
    }
    try {
      const run = await startCodexRun(request, spec)
      if (modelOwner === undefined) return run
      let closing: Promise<void> | undefined
      return { ...run, dispose() {
        closing ??= (async () => {
          const outcomes = await Promise.allSettled([modelOwner.close(), run.dispose()])
          const failures = outcomes.flatMap((outcome): unknown[] => outcome.status === 'rejected' ? [outcome.reason] : [])
          if (failures.length > 0) throw new AggregateError(failures, 'Codex model transport or process cleanup failed.')
        })()
        return closing
      } }
    } catch (error) {
      try { await modelOwner?.close() } catch (cleanupError) {
        throw new AggregateError([error, cleanupError], 'Codex startup and model transport cleanup failed.')
      }
      throw error
    }
  }
}

function resolveModel(
  ctx: Context, parent: ResolvedSubagentStartRequest['parent'], config: ResolvedConfig, store?: ExternalBindingStore,
): ExternalModelSelection {
  const managed = config.modelProvider !== undefined || requiresParentModelControl(ctx) || requiresParentModelControl(parent.ctx)
  if (!managed) return { mode: 'native' }
  const inherited = store?.modelSelection(parent.id)
  const route = inherited?.mode === 'managed' ? inherited : parent.session.requestHeader()?.config ?? parent.options
  const provider = config.modelProvider ?? route.provider
  const model = config.model ?? route.model
  if (provider === undefined || model === undefined) {
    throw new SubagentError('Managed Codex requires a registered Responses model route.', 'UNSUPPORTED_CAPABILITY')
  }
  return { mode: 'managed', provider, model }
}

/**
 * Register one Profile-named Codex provider.
 * @param ctx - context carrying shared subagent and subprocess services.
 * @param config - registry name, optional model, permission mode, child environment, and disposal grace.
 */
export function apply(ctx: Context, config: Config): void {
  const resolved: ResolvedConfig = {
    providerName: config.providerName ?? DEFAULT_PROVIDER_NAME,
    ...config.model === undefined ? {} : { model: config.model },
    ...config.modelProvider === undefined ? {} : { modelProvider: config.modelProvider },
    modelRequestBytes: config.modelRequestBytes ?? DEFAULT_MODEL_REQUEST_BYTES,
    modelResponseBytes: config.modelResponseBytes ?? DEFAULT_MODEL_RESPONSE_BYTES,
    modelRequestTimeoutMs: config.modelRequestTimeoutMs ?? DEFAULT_MODEL_REQUEST_TIMEOUT_MS,
    modelPendingRequests: config.modelPendingRequests ?? DEFAULT_MODEL_PENDING_REQUESTS,
    env: config.env as Record<string, string>,
    permissionMode: config.permissionMode ?? DEFAULT_CODEX_PERMISSION_MODE,
    disposeGraceMs: config.disposeGraceMs as number,
    ...config.stateDir === undefined ? {} : { stateDir: config.stateDir },
    ...config.memberCwd === undefined ? {} : { memberCwd: config.memberCwd },
    remoteCommand: config.remoteCommand ?? 'codex',
  }
  assertPositiveFinite(
    'subagent-codex',
    'disposeGraceMs',
    resolved.disposeGraceMs,
  )
  if (resolved.disposeGraceMs > MAX_TIMER_DELAY_MS) {
    throw new Error(
      `subagent-codex: disposeGraceMs must be no greater than ${MAX_TIMER_DELAY_MS}`,
    )
  }
  // Persistent members need the `llm` service to resolve their model route.
  // When no LLM capability is mounted the provider stays one-shot only:
  // without `prepareContinuable` the service rejects continuable starts.
  const llm = ctx.get('llm')
  const identity = externalMemberIdentity(resolved.providerName, DEFAULT_PROVIDER_NAME, CODEX_MEMBER_ROUTE)
  let memberRoute: string | undefined
  let memberStore: ExternalBindingStore | undefined
  if (llm !== undefined) {
    const store = new ExternalBindingStore(
      join(resolved.stateDir ?? join(homedir(), '.dsh', 'external-members'), identity.filename),
    )
    memberStore = store
    const transport = async (child: SessionId, signal: AbortSignal) => {
      const agent = externalMemberAgent(ctx, child)
      let selection = store.modelSelection(child)
      if (selection === undefined) {
        selection = resolveModel(ctx, agent, resolved, store)
        store.selectModel(child, selection)
      }
      if (selection.mode === 'native') {
        assertExternalModelExecution(ctx)
        assertExternalModelExecution(agent.ctx)
      }
      const execution = await resolveChildExecution(ctx, agent, resolved.memberCwd, signal)
      const forward = selection.mode === 'managed' ? await managedForward(ctx, agent, execution) : undefined
      store.assertExecution(child, execution)
      const memberConfig: CodexMemberConfig = {
        cwd: execution.cwd, remote: execution.remote,
        ...execution.remote ? {
          executable: await execution.subprocess.resolveExecutable(resolved.remoteCommand, resolved.env, signal),
        } : {},
        ...resolved.model === undefined ? {} : { model: resolved.model },
        permissionMode: resolved.permissionMode, env: resolved.env, disposeGraceMs: resolved.disposeGraceMs,
      }
      const modelRoute = selection.mode === 'native' ? undefined : selection
      return new CodexMemberTransport(memberConfig,
        spec => execution.subprocess.spawn({ ...spec, sessionId: child, resourceOrigin: 'execution' }),
        modelRoute === undefined ? undefined : modelSignal => startManagedCodexModel(ctx, agent, {
          ...modelRoute, maxRequestBytes: resolved.modelRequestBytes,
          maxResponseBytes: resolved.modelResponseBytes, requestTimeoutMs: resolved.modelRequestTimeoutMs,
          maxPendingRequests: resolved.modelPendingRequests,
        }, modelSignal, forward))
    }
    ctx.effect(() => {
      const registration = llm.registerAdapter(
        [identity.route],
        new CodexMemberAdapter(transport, store),
      )
      return () => { registration() }
    })
    memberRoute = identity.route
  }
  ctx.subagents.registerProvider(new CodexProvider(
    resolved.providerName,
    ctx,
    resolved,
    memberRoute,
    memberStore,
  ))
}
