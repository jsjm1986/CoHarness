/** Materialize the persistent native Codex child-admission profile for standalone SDKs. */
import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { materializeProfilePatch } from '../../../../../packages/test-support/session-snapshot/lib/index.js'

const cwd = process.argv[2]
if (cwd === undefined) throw Error('Managed Codex fixture requires its owned workspace')
const patchRoot = join(cwd, '.snapshot-patches')
await mkdir(patchRoot, { recursive: true })
const patch = materializeProfilePatch(fileURLToPath(new URL('./runtime.cordis.yml', import.meta.url)), cwd, 'sdk-minimal', patchRoot, 0)
process.stdout.write(JSON.stringify({ patches: [patch], provider: 'codex-conversation-fixture', model: 'conversation', task: 'Run managed Codex.' }) + '\n')
