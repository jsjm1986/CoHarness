/** v3-capped catalog for edge tests: CoHarness installs v4, so edge specs pin the released v3 chain. */

import { createSessionFormatCatalog } from '@deepseek-ai/dsh-session-format'
import { releasedV0SessionFormatCodec, releasedV1SessionFormatCodec, sessionFormatV0ToV1 } from '@deepseek-ai/dsh-session-format-v0-to-v1'
import { releasedV2SessionFormatCodec, sessionFormatV1ToV2 } from '@deepseek-ai/dsh-session-format-v1-to-v2'
import { assertReleasedV3Header, releasedV3SessionFormatCodec, restoreReleasedV3Artifact, sessionFormatV2ToV3 } from '../src/index.ts'

/** The complete released v0→v3 chain, capped before the CoHarness v4 fold. */
export const v3SessionFormatCatalog = createSessionFormatCatalog({
  currentVersion: 3,
  codecs: [releasedV0SessionFormatCodec, releasedV1SessionFormatCodec, releasedV2SessionFormatCodec, releasedV3SessionFormatCodec],
  currentEncoder: releasedV3SessionFormatCodec,
  migrations: [sessionFormatV0ToV1, sessionFormatV1ToV2, sessionFormatV2ToV3],
  restoreCurrent: artifact => restoreReleasedV3Artifact(artifact, new Set()),
  restoreTransformedCurrent: artifact => restoreReleasedV3Artifact(artifact, new Set()),
  restoreCurrentHeader: (header) => {
    assertReleasedV3Header(header)
    return header
  },
})
