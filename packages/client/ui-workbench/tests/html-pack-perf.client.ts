/** Client-face production-packer diagnostic; synthetic files and controlled read completions only. */
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { setImmediate } from 'node:timers/promises'
import { JSDOM } from 'jsdom'
import { packHtml } from '../src/client/contract/html/pack.ts'

const dom = new JSDOM('')
const previousDocument = globalThis.document
globalThis.document = dom.window.document
try {
  const references = Array.from({ length: 24 }, (_, index) => `asset-${index}.js`)
  const data = new TextEncoder().encode(references.map(reference => `<script src="${reference}"></script>`).join(''))
  const pending: { complete: () => void }[] = []
  let peakPending = 0
  let reads = 0
  const packing = packHtml(data, async (reference) => {
    const completion = Promise.withResolvers<Uint8Array<ArrayBuffer>>()
    pending.push({ complete: () => { completion.resolve(new TextEncoder().encode(`/* ${reference} */`)) } })
    peakPending = Math.max(peakPending, pending.length)
    reads++
    return completion.promise
  }, new AbortController().signal)
  let waves = 0
  while (pending.length > 0) {
    const wave = pending.splice(0)
    waves++
    for (const read of wave) read.complete()
    await setImmediate()
  }
  const bundle = await packing
  const hash = createHash('sha256').update(bundle.data)
  for (const asset of bundle.assets) hash.update(asset.kind).update(asset.reference).update(asset.type).update(asset.data)
  console.log(JSON.stringify({
    runtime: { node: process.versions.node, platform: process.platform, arch: process.arch },
    sourceSha256: createHash('sha256').update(await readFile(new URL('../src/client/contract/html/pack.ts', import.meta.url))).digest('hex'),
    assets: bundle.assets.length,
    reads,
    controlledReadWaves: waves,
    peakPendingReads: peakPending,
    orderPreserved: bundle.assets.every((asset, index) => asset.reference === references[index]),
    resultSha256: hash.digest('hex'),
  }))
} finally {
  globalThis.document = previousDocument
  dom.window.close()
}
