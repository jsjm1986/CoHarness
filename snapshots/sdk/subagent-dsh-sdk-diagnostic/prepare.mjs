/** Materialize the recorded diagnostic composition for the Python SDK. */
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { materializeProfilePatch } from '../../../packages/test-support/session-snapshot/lib/index.js'

const root = fileURLToPath(new URL('../../../', import.meta.url))
const cwd = process.argv[2]
if (cwd === undefined) throw new Error('SDK diagnostic fixture requires its owned workspace directory')
const patchRoot = join(cwd, '.snapshot-patches')
await mkdir(patchRoot, { recursive: true })
const patches = [
  'snapshots/sdk/subagent-dsh-sdk-diagnostic/cordis.yml',
  'snapshots/sdk/subagent-dsh-sdk-diagnostic/cordis.snapshot.yml',
  'snapshots/session/text-turn/model.cordis.yml',
].map((path, index) => materializeProfilePatch(join(root, path), cwd, 'sdk', patchRoot, index, join(root, 'examples/package.json')))
const fixture = (await readFile(new URL('./session.v7.jsonl', import.meta.url), 'utf8')).replaceAll('{{cwd}}', cwd)
const records = fixture.trimEnd().split('\n').map(line => JSON.parse(line))
const header = records.find(record => record.type === 'request/header')?.data.header.config
const user = records.find(record => record.type === 'user/message')?.data
if (header === undefined || user === undefined) throw new Error('SDK diagnostic fixture has no route or task')
const replay = join(patchRoot, 'session.v7.jsonl')
await writeFile(replay, fixture)
process.stdout.write(JSON.stringify({ patches, replay, provider: header.provider, model: header.model,
  task: user.content.filter(block => block.type === 'text').map(block => block.text).join('\n'),
  override: fileURLToPath(new URL('./replay.override.json', import.meta.url)),
  childPatch: fileURLToPath(new URL('./child.cordis.yml', import.meta.url)),
}) + '\n')
