/** Adapter-owned model operations dispatched through ordinary model policy and resource ownership. */

import type { LlmCallConfig } from './call-config.ts'
import type { GenerateOptions, TokenUsage } from './types.ts'
import type { LlmOperationMap } from './index.ts'

/** Parameters, secret-free recorded request and result owned by one model-operation implementation. */
export interface LlmOperationDefinition<Parameters, Request, Result> {
  /** Inputs accepted by the operation factory. */
  readonly parameters: Parameters
  /** Exact secret-free request the Consumer records before dispatch. */
  readonly request: Request
  /** Provider result returned after transport cleanup. */
  readonly result: Result
}

/** Parameters accepted by one contributed operation. */
export type LlmOperationParameters<Name extends keyof LlmOperationMap> =
  LlmOperationMap[Name] extends { parameters: infer Parameters } ? Parameters : never

/** Secret-free, reconstructable request published by one contributed operation. */
export type LlmOperationRequest<Name extends keyof LlmOperationMap> =
  LlmOperationMap[Name] extends { request: infer Request } ? Request : never

/** Result produced by one contributed operation. */
export type LlmOperationResult<Name extends keyof LlmOperationMap> =
  LlmOperationMap[Name] extends { result: infer Result } ? Result : never

/** Model-visible operation request supplied to middleware instead of conversation messages. */
export type LlmOperationInput = {
  [Name in keyof LlmOperationMap]: { readonly name: Name; readonly request: LlmOperationRequest<Name> }
}[keyof LlmOperationMap]

/**
 * One provider I/O operation invoked after the retained model policy is rechecked.
 * @param request - starts provider I/O using already-resolved authentication.
 * @returns the result of the authorized request.
 */
export type LlmOperationDispatch = <T>(request: () => Promise<T>) => Promise<T>

/** Usage emitted by a completed or failed operation before its terminal outcome. */
export interface LlmOperationObserver {
  /**
   * Recheck authorization after asynchronous preparation, then start owned provider I/O.
   * Call once after resolving credentials. The operation owns transport cleanup until `run` settles.
   * @param request - starts the provider transport using already-resolved authentication.
   * @returns the transport result after final policy and cancellation checks.
   */
  dispatch: LlmOperationDispatch
  /**
   * Publish cumulative provider usage; a later report replaces an earlier one.
   * @param usage - actual provider token counts, never an estimate or invented zero.
   * @param credentialSource - source of the credential that authenticated this request.
   */
  usage(usage: TokenUsage, credentialSource?: string): void
}

/** One operation bound to the same adapter generation as its model metadata. */
export interface PreparedAdapterOperation<Name extends keyof LlmOperationMap> {
  /** Detached secret-free request whose exact fields are sent by {@link run}. */
  readonly request: LlmOperationRequest<Name>
  /**
   * Execute after model admission and final policy checks. Completion includes owned transport cleanup.
   * @param options - resolved model options, operation input and effective cancellation.
   * @param observer - actual usage, including usage available before a later failure.
   * @returns the operation result; rejection preserves the provider failure.
   */
  run(options: GenerateOptions, observer: LlmOperationObserver): Promise<LlmOperationResult<Name>>
}

/** Optional operation factories captured by one prepared adapter call; preparation must not dispatch HTTP. */
export type LlmOperationFactories = {
  [Name in keyof LlmOperationMap]?: (
    this: void,
    parameters: LlmOperationParameters<Name>,
    config: LlmCallConfig,
  ) => PreparedAdapterOperation<Name>
}
