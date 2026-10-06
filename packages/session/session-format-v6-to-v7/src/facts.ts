/** Parent-owned catalog fact validation for migrated and native artifacts. */

import { SessionFormatError, isSessionFormatJsonObject, sessionFormatCount } from '@deepseek-ai/dsh-session-format'
import type { SessionFormatJsonObject, SessionFormatJsonValue } from '@deepseek-ai/dsh-session-format'

/**
 * Validate the historical fields used for catalog membership without interpreting extensions.
 * @param value - catalog payload.
 * @param subject - event type or child identity used in rejection diagnostics.
 * @returns validated catalog payload.
 */
export function catalogFact(value: SessionFormatJsonValue, subject = 'subagent/catalog'): SessionFormatJsonObject {
  if (!isSessionFormatJsonObject(value) || (value['version'] !== 0 && value['version'] !== 1)
    || typeof value['childId'] !== 'string'
    || (value['mode'] !== 'continuable' && value['mode'] !== 'one-shot' && value['mode'] !== 'unknown')
    || (value['version'] === 0 && value['mode'] === 'unknown')
    || (value['mode'] === 'continuable' && typeof value['label'] !== 'string')
    || (value['label'] !== undefined && typeof value['label'] !== 'string')) {
    throw new SessionFormatError(`${subject} requires a supported versioned catalog fact`)
  }
  sessionFormatCount(value['childCreatedAt'], 'catalog child creation time')
  return value
}
