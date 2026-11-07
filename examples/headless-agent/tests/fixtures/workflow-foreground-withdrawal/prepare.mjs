/** Materialize a private SDK profile for foreground Workflow withdrawal. */
import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { materializeProfilePatch } from '../../../../../packages/test-support/session-snapshot/lib/index.js'
const cwd = process.argv[2]
if (cwd === undefined) throw new Error('Withdrawal fixture requires its owned workspace')
const root = join(cwd, '.snapshot-patches')
await mkdir(root, { recursive: true })
const patch = materializeProfilePatch(fileURLToPath(new URL('./runtime.cordis.yml', import.meta.url)), cwd, 'sdk-minimal', root, 0)
process.stdout.write(JSON.stringify({ patches: [patch], provider: 'workflow-withdrawal-fixture', model: 'main-model' }) + '\n')
