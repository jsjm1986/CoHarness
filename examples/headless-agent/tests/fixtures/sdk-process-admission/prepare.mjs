/** Materialize the real SDK child-process composition against built packages. */
import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { materializeProfilePatch } from '../../../../../packages/test-support/session-snapshot/lib/index.js'
import { prepareGovernance } from './prepare-governance.mjs'

const cwd = process.argv[2]
if (cwd === undefined) throw new Error('SDK child-process fixture requires its owned workspace')
const patchRoot = join(cwd, '.snapshot-patches')
await mkdir(patchRoot, { recursive: true })
const patch = materializeProfilePatch(fileURLToPath(new URL('./runtime.cordis.yml', import.meta.url)),
  cwd, 'sdk-minimal', patchRoot, 0)
await prepareGovernance(join(cwd, '.dsh'))
process.stdout.write(JSON.stringify({ patches: [patch], provider: 'owned-sdk-parent', model: 'm',
  task: 'Delegate one owned task.' }) + '\n')
