/** Materialize the shared browser composition for the Python SDK's built-runtime projection. */
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { materializeProfilePatch } from '../../../packages/test-support/session-snapshot/lib/index.js'

const root = fileURLToPath(new URL('../../../', import.meta.url))
const cwd = process.argv[2]
if (cwd === undefined) throw new Error('Browser SDK fixture requires its owned workspace directory')
const patchRoot = join(cwd, '.snapshot-patches')
await mkdir(patchRoot, { recursive: true })
const patches = [
  'snapshots/session/text-turn/cordis.yml',
  'snapshots/session/browser-use-stagehand-native/cordis.snapshot.yml',
  'snapshots/session/text-turn/model.cordis.yml',
].map((path, index) => materializeProfilePatch(join(root, path), cwd, 'sdk', patchRoot, index))
const fixture = (await readFile(new URL('./session.v7.jsonl', import.meta.url), 'utf8')).replaceAll('{{cwd}}', cwd)
const records = fixture.trimEnd().split('\n').map(line => JSON.parse(line))
const header = records.find(record => record.type === 'request/header')?.data.header.config
const user = records.find(record => record.type === 'user/message')?.data
if (header === undefined || user === undefined) throw new Error('Browser SDK fixture has no route or task')
const replay = join(patchRoot, 'session.v7.jsonl')
await writeFile(replay, fixture)
process.stdout.write(JSON.stringify({ patches, replay, provider: header.provider, model: header.model,
  task: user.content.filter(block => block.type === 'text').map(block => block.text).join('\n'),
  override: fileURLToPath(new URL('./replay.override.json', import.meta.url)),
}) + '\n')
