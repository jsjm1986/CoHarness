import { clientBundle } from '../../client/tsdown.client.ts'

export default clientBundle(
  '@deepseek-ai/dsh-api-remote-desktop-controller',
  ['lib/types/index.js'],
  { hostPhase: true, codeSplitting: false },
)
