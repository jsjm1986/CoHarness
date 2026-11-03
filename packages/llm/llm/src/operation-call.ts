/** Once-only operation execution through the model runtime's registration-bound stream. */
import { deepFreeze } from './call-config.ts'
import type { LlmCallConfig } from './call-config.ts'
import { LlmError } from './error.ts'
import type { LlmOperationMap, PreparedLlmCall, PreparedLlmOperation } from './index.ts'
import type { LlmOperationDispatch, LlmOperationFactories, LlmOperationInput, LlmOperationParameters, LlmOperationResult } from './operations.ts'
import type { GenerateOptions, StreamChunk } from './types.ts'

/**
 * Reject operation descriptors without their exact prepared dispatch.
 * @param actual - request descriptor supplied to model middleware.
 * @param expected - descriptor owned by the captured adapter generation, or absence for ordinary calls.
 */
export function assertPreparedOperationInput(actual?: LlmOperationInput, expected?: LlmOperationInput): void {
  if (actual !== expected) throw new LlmError('Prepared model operation input changed before dispatch.', 'INVALID_PREPARED_CALL')
}

/**
 * Bind an operation's request and result to the ordinary model stream policy.
 * @param config - frozen resolved model config from the captured generation.
 * @param name - contributed operation name.
 * @param parameters - caller's operation input.
 * @param factories - operation factories captured with model metadata.
 * @param bind - creates the ordinary once-only registration-bound stream.
 * @returns frozen recorded input and an operation result that requires actual execution.
 */
export function createPreparedOperation<Name extends keyof LlmOperationMap>(
  config: LlmCallConfig,
  name: Name,
  parameters: LlmOperationParameters<Name>,
  factories: LlmOperationFactories | undefined,
  bind: (
    dispatch: (options: GenerateOptions, dispatchRequest: LlmOperationDispatch) => AsyncIterable<StreamChunk>,
    input: LlmOperationInput,
  ) => PreparedLlmCall,
): PreparedLlmOperation<Name> {
  const factory = factories?.[name]
  if (factory === undefined) {
    throw new LlmError(`Provider "${config.provider}" does not support model operation "${name}".`, 'MODEL_OPERATION_UNSUPPORTED')
  }
  const operation = factory(parameters, config)
  const request = deepFreeze(structuredClone(operation.request))
  // TypeScript does not retain the mapped name/request correlation for a generic object literal.
  const input = deepFreeze({ name, request }) as LlmOperationInput
  const capture: { outcome: { ready: false } | { ready: true; result: LlmOperationResult<Name> } } = { outcome: { ready: false } }
  const call = bind(async function* (options, dispatchRequest): AsyncIterable<StreamChunk> {
    let usage: Extract<StreamChunk, { type: 'usage' }> | undefined
    let dispatched = false
    try {
      const result = await operation.run(options, {
        dispatch: (request) => {
          if (dispatched) throw new LlmError('A prepared model operation can dispatch only once.', 'INVALID_PREPARED_CALL')
          dispatched = true
          return dispatchRequest(request)
        },
        usage: (counts, credentialSource) => {
          usage = { type: 'usage', usage: structuredClone(counts), ...credentialSource === undefined ? {} : { credentialSource } }
        },
      })
      capture.outcome = { ready: true, result }
    } catch (error) {
      if (usage !== undefined) yield usage
      throw error
    }
    if (usage !== undefined) yield usage
    yield { type: 'finish', reason: { kind: 'stop' } }
  }, input)
  // oxlint-disable-next-line typescript/unbound-method -- Only metadata is retained; the omitted dispatcher is never invoked.
  const { stream: _stream, ...metadata } = call
  return Object.freeze({
    ...metadata,
    request,
    async run(options: Omit<GenerateOptions, 'messages' | 'operation'>): Promise<LlmOperationResult<Name>> {
      for await (const chunk of call.stream(deepFreeze({ ...options, messages: [], operation: input }))) {
        if (chunk.type !== 'finish') continue
        switch (chunk.reason.kind) {
          case 'error':
            throw new LlmError(chunk.reason.failure.message, chunk.reason.failure.code, { cause: chunk.reason.failure })
          case 'aborted':
            throw new LlmError(chunk.reason.failure.message, 'ABORTED', { cause: chunk.reason.failure })
          default:
            // Merge-extensible non-error terminal reasons retain the adapter's completed result.
            break
        }
      }
      if (!capture.outcome.ready) throw new LlmError('Model middleware completed without an operation result.', 'MODEL_OPERATION_RESULT_MISSING')
      return capture.outcome.result
    },
  })
}
