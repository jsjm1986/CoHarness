/** Materialize the governed automatic-compaction fixture against built runtime packages. */
import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { materializeProfilePatch } from '../../../../../packages/test-support/session-snapshot/lib/index.js'
import { prepareGovernance } from '../sdk-process-admission/prepare-governance.mjs'

const cwd = process.argv[2]
if (cwd === undefined) throw new Error('Governance SDK fixture requires its owned workspace')
await prepareGovernance(join(cwd, '.dsh'))
const patchRoot = join(cwd, '.snapshot-patches')
await mkdir(patchRoot, { recursive: true })
const patch = materializeProfilePatch(fileURLToPath(new URL('./runtime.cordis.yml', import.meta.url)),
  cwd, 'sdk-minimal', patchRoot, 0)
process.stdout.write(JSON.stringify({ patches: [patch], provider: 'governance-fixture', model: 'governance-model' }) + '\n')
