/** Typed entry point for the runnable native Codex fixture in source integration tests. */
import type { Context, Plugin } from '@deepseek-ai/cordis'

/** Fixture-only switches; production model and resource owners remain installed. */
export interface Config {
  /** Send an incomplete authenticated body before native Codex startup. */
  readonly probeModelBodyDeadline?: boolean
  readonly inheritParentAdmission?: boolean
  readonly persistentMember?: boolean
  readonly httpCounterFile?: string
  readonly completionFile?: string
}

/** Services used by the fixture's real Agent, provider and request checkpoint. */
export declare const inject: string[]

/** Workspace modules resolved by the embedding process, without mixing built and source classes. */
export interface Services {
  readonly llm: Pick<typeof import('@deepseek-ai/dsh-llm'), 'LlmAdapter' | 'ToolCallId'>
  readonly session: Pick<typeof import('@deepseek-ai/dsh-session'), 'appendPluginRecord' | 'SessionId' | 'SessionLogOffset'>
  readonly tools: Pick<typeof import('@deepseek-ai/dsh-tools'), 'defineContentToolFixture'>
  readonly piAi: typeof import('@deepseek-ai/dsh-llm-pi-ai')
  readonly codex: typeof import('@deepseek-ai/dsh-subagent-codex')
}

/**
 * Bind the fixture to the current source integration test's module identities.
 * @param services - modules imported through the embedding test's resolver.
 * @returns a Cordis plugin using those exact runtime classes and helpers.
 */
export declare function createManagedCodexFixture(services: Services): Plugin<Config>

/**
 * Compose native Codex and its owned Responses peer through the current module resolver.
 * @param ctx - composed runtime and durable Session services.
 * @param config - resource ownership and optional completion probes.
 * @returns after the model endpoint and Codex provider are mounted.
 */
export declare function apply(ctx: Context, config?: Config): Promise<void>
