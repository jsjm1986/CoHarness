import type { KnipConfiguration } from 'knip'

import baseConfig from './knip.json' with { type: 'json' }

const config: KnipConfiguration = baseConfig as KnipConfiguration

export default config
