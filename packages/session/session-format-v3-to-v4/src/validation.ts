/** Released-V4 header and artifact validation over the V3 vocabulary rules. */

import { SessionFormatError } from '@deepseek-ai/dsh-session-format'
import type { SessionFormatArtifact, SessionFormatHeader } from '@deepseek-ai/dsh-session-format'
import { assertReleasedV3Header, restoreReleasedV3Artifact } from '@deepseek-ai/dsh-session-format-v2-to-v3'

/**
 * Validate one v4 logical header: every v3 rule plus the version marker.
 * @param header - detached v4 header candidate.
 * @returns nothing after successful validation.
 */
export function assertReleasedV4Header(header: SessionFormatHeader): void {
  if (header.version !== 4) throw new SessionFormatError('expected format v4 header')
  assertReleasedV3Header({ ...header, version: 3 })
}

/**
 * Validate one v4 artifact: v3 rules, plus refusal of the pre-fold
 * `assistant/chunk` rows that v4 settles into assistant events.
 * @param artifact - detached v4 artifact.
 * @param knownEventTypes - event types understood by the installed Session package.
 * @returns the same validated artifact.
 */
export function restoreReleasedV4Artifact(
  artifact: SessionFormatArtifact,
  knownEventTypes: ReadonlySet<string>,
): SessionFormatArtifact {
  assertReleasedV4Header(artifact.header)
  for (const event of artifact.events) {
    if (event.type === 'assistant/chunk') {
      throw new SessionFormatError('format v4 stores settled assistant events; assistant/chunk is a v3 row')
    }
  }
  const restored = restoreReleasedV3Artifact(
    { ...artifact, header: { ...artifact.header, version: 3 } },
    knownEventTypes,
  )
  return { ...restored, header: artifact.header }
}
