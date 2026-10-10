/** Historical restoration for collecting migration prerequisites without recursively opening current Sessions. */

import { createSessionFormatCatalog } from '@deepseek-ai/dsh-session-format'
import { releasedV0SessionFormatCodec, releasedV1SessionFormatCodec, sessionFormatV0ToV1 } from '@deepseek-ai/dsh-session-format-v0-to-v1'
import { releasedV2SessionFormatCodec, sessionFormatV1ToV2 } from '@deepseek-ai/dsh-session-format-v1-to-v2'
import { releasedV3SessionFormatCodec, sessionFormatV2ToV3 } from '@deepseek-ai/dsh-session-format-v2-to-v3'
import { releasedV4SessionFormatCodec, sessionFormatV3ToV4 } from '@deepseek-ai/dsh-session-format-v3-to-v4'
import { releasedV5SessionFormatCodec, sessionFormatV4ToV5 } from '@deepseek-ai/dsh-session-format-v4-to-v5'
import { assertReleasedV6Header, releasedV6SessionFormatCodec, restoreReleasedV6Artifact, sessionFormatV5ToV6 } from '@deepseek-ai/dsh-session-format-v5-to-v6'
import { ADMITTED_V6_EVENT_TYPES } from '@deepseek-ai/dsh-session-format-v6-to-v7'

/** V0–V6 decoding for historical child identity; never publishes or completes parent catalogs. */
export const historicalSessionFormatCatalog = createSessionFormatCatalog({
  currentVersion: 6,
  codecs: [
    releasedV0SessionFormatCodec,
    releasedV1SessionFormatCodec,
    releasedV2SessionFormatCodec,
    releasedV3SessionFormatCodec,
    releasedV4SessionFormatCodec,
    releasedV5SessionFormatCodec,
    releasedV6SessionFormatCodec,
  ],
  currentEncoder: releasedV6SessionFormatCodec,
  migrations: [
    sessionFormatV0ToV1,
    sessionFormatV1ToV2,
    sessionFormatV2ToV3,
    sessionFormatV3ToV4,
    sessionFormatV4ToV5,
    sessionFormatV5ToV6,
  ],
  restoreCurrent: artifact => restoreReleasedV6Artifact(artifact, ADMITTED_V6_EVENT_TYPES),
  restoreTransformedCurrent: artifact => restoreReleasedV6Artifact(artifact, ADMITTED_V6_EVENT_TYPES),
  restoreCurrentHeader(header) {
    assertReleasedV6Header(header)
    return header
  },
})
