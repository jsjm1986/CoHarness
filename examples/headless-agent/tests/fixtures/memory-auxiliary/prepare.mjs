/** Materialize one owned SDK composition shared by TypeScript and Python acceptance. */
import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { materializeProfilePatch } from '../../../packages/test-support/session-snapshot/lib/index.js'

const cwd = process.argv[2]
if (cwd === undefined) throw new Error('Memory SDK fixture requires its owned workspace')
const patchRoot = join(cwd, '.snapshot-patches')
await mkdir(patchRoot, { recursive: true })
const patch = materializeProfilePatch(fileURLToPath(new URL('./runtime.cordis.yml', import.meta.url)),
  cwd, 'sdk-minimal', patchRoot, 0)
process.stdout.write(JSON.stringify({ patches: [patch], provider: 'memory-fixture', model: 'memory-model',
  task: 'Remember the Friday release freeze.' }) + '\n')
