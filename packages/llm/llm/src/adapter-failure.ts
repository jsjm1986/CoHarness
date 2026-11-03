/**
 * Normalization for model admission and final adapter failures.
 *
 * @module @deepseek-ai/dsh-llm/adapter-failure
 */

import { HarnessError } from './error.ts'
import { ResourceAdmissionError } from '@deepseek-ai/dsh-resource-budget'
import type { LlmFailure } from './types.ts'

const RESOURCE_ADMISSION_CODES = {
  unavailable: 'RESOURCE_BUDGET_UNAVAILABLE',
  cancelled: 'ABORTED',
  expired: 'RESOURCE_ADMISSION_EXPIRED',
  refused: 'RESOURCE_ADMISSION_REFUSED',
} as const satisfies Record<ResourceAdmissionError['reason'], string>

/**
 * Detach serializable facts from a model admission or adapter failure.
 * @param value - arbitrary value thrown during admission, adapter dispatch, or iteration.
 * @returns immutable provider-neutral facts suitable for a terminal finish chunk.
 * @internal
 */
export function normalizeLlmFailure(value: unknown): LlmFailure {
  const error = value instanceof Error
    ? value
    : new HarnessError(thrownMessage(value), 'UNKNOWN', { cause: value })
  // Cross-package copies preserve own data but not class identity. Trust the
  // carried facts only when both own properties agree after validation.
  const carried = ownFailureSnapshot(error)
  if (carried !== undefined && carried.code === ownErrorCode(error)) return carried
  return Object.freeze({
    message: errorMessage(error),
    code: resourceAdmissionCode(error) ?? harnessErrorCode(error),
  })
}

/** Classify only owned admission errors with a readable data-backed reason. */
function resourceAdmissionCode(error: Error): string | undefined {
  try {
    if (!(error instanceof ResourceAdmissionError)) return undefined
    const reason: unknown = Object.getOwnPropertyDescriptor(error, 'reason')?.value
    if (typeof reason !== 'string' || !Object.hasOwn(RESOURCE_ADMISSION_CODES, reason)) return undefined
    return RESOURCE_ADMISSION_CODES[reason as keyof typeof RESOURCE_ADMISSION_CODES]
  } catch (_admissionErrorReflectionFailed) {
    return undefined
  }
}

/** Render a non-Error throw without letting hostile coercion escape normalization. */
function thrownMessage(value: unknown): string {
  try {
    const message = String(value)
    return message.length > 0 ? message : 'LLM adapter failed'
  } catch (_hostileThrownValue) {
    return 'LLM adapter failed'
  }
}

/** Read a foreign error's own data-backed `code` without invoking accessors. */
function ownErrorCode(error: Error): unknown {
  try {
    const descriptor = Object.getOwnPropertyDescriptor(error, 'code')
    return descriptor !== undefined && 'value' in descriptor ? descriptor.value : undefined
  } catch (_sdkPropertyTrap) {
    return undefined
  }
}

/** Snapshot an own data property without invoking an SDK-defined accessor. */
function ownFailureSnapshot(error: Error): LlmFailure | undefined {
  try {
    const descriptor = Object.getOwnPropertyDescriptor(error, 'failure')
    return descriptor !== undefined && 'value' in descriptor
      ? failureSnapshot(descriptor.value)
      : undefined
  } catch (_sdkPropertyTrap) {
    return undefined
  }
}

/** Validate and detach an arbitrary serializable failure payload. */
function failureSnapshot(value: unknown): LlmFailure | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  try {
    const candidate = value as Partial<LlmFailure>
    const message = candidate.message
    const code = candidate.code
    const status = candidate.status
    const providerRetryAfterMs = candidate.providerRetryAfterMs
    const requestId = candidate.requestId
    const offloadImages = candidate.offloadImages
    if (typeof message !== 'string' || message.length === 0
      || typeof code !== 'string' || code.length === 0
      || (status !== undefined && (!Number.isInteger(status) || status < 100 || status > 599))
      || (providerRetryAfterMs !== undefined
        && (!Number.isFinite(providerRetryAfterMs) || providerRetryAfterMs <= 0))
      || (requestId !== undefined && (typeof requestId !== 'string' || requestId.length === 0))
      || (offloadImages !== undefined && (!Number.isSafeInteger(offloadImages) || offloadImages <= 0))) return undefined
    return Object.freeze({
      message,
      code,
      ...status === undefined ? {} : { status },
      ...providerRetryAfterMs === undefined ? {} : { providerRetryAfterMs },
      ...requestId === undefined ? {} : { requestId },
      ...offloadImages === undefined ? {} : { offloadImages },
    })
  } catch (_sdkFailureGetter) {
    return undefined
  }
}

/** Read an SDK error message without letting an accessor replace the primary failure. */
function errorMessage(error: Error): string {
  try {
    const message: unknown = error.message
    if (typeof message === 'string' && message.length > 0) return message
  } catch (_sdkMessageGetter) {
    // The fallback below preserves a serializable failure beside the original Error.
  }
  return 'LLM adapter failed'
}

/** Trust only Harness-owned codes; third-party SDK codes are not our taxonomy. */
function harnessErrorCode(error: Error): string {
  return error instanceof HarnessError ? error.code : 'UNKNOWN'
}
