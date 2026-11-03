/** Linux descriptor paths retain the admitted directory objects through filesystem mutations. */
import { readFile } from 'node:fs/promises'
import { expect, it } from 'vitest'
import { replayLinuxDocumentObjects } from './fixtures/linux-object-replay.ts'

it.skipIf(process.platform !== 'linux')('preserves outside objects during parent replacement and completes identified lifecycle work', async () => {
  const events = await replayLinuxDocumentObjects()
  const expected = await readFile(new URL('./expected/linux-object-replay.jsonl', import.meta.url), 'utf8')
  expect(events.map(event => JSON.stringify(event)).join('\n') + '\n').toBe(expected)
})

it.skipIf(process.platform !== 'linux' || process.getuid?.() !== 0)(
  'keeps upload controls private from a separate runtime UID and ignores forged public manifests', async () => {
    const events = await replayLinuxDocumentObjects('publish', true)
    expect(events).toEqual([{
      operation: 'managed-controls-cross-uid',
      ordinary: 'EACCES',
      actor: 'EACCES',
      forgedManifest: 'written',
      forgedManifestIgnored: true,
      privateUploadPublished: true,
    }, { operation: 'publish', outsidePreserved: true, foreignTouched: false, refused: true }])
  },
)
