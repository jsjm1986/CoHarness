/** Actual speech registry shutdown joins accepted work after lookup withdrawal. */
import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { setImmediate as yieldEventLoop } from 'node:timers/promises'
import { boot } from '@deepseek-ai/dsh-app-boot'
import { LlmAdapter } from '@deepseek-ai/dsh-llm'

export const inject = ['llm']

/** Keep only external recognition work controlled while the real registry and SDK execute. */
export async function apply(ctx) {
  const phase = process.env.DSH_SPEECH_REMOVAL_PHASE
  assert.ok(['duplicate', 'registry'].includes(phase))
  const face = process.env.DSH_EXAMPLE_MODE === 'src' ? 'src/index.ts' : 'lib/index.js'
  const Speech = await import(new URL(`../../../../../packages/experimental/speech-to-text/${face}`, import.meta.url))
  const directory = join(process.cwd(), 'speech-removal')
  await mkdir(directory)
  const config = join(directory, 'cordis.yml')
  await writeFile(config, JSON.stringify([{ id: 'speech', name: 'cordis:speech', config: { defaultProvider: 'local', language: 'auto' } }]))
  const voice = await boot('speech-removal', config, [], host => { host.loader.builtins.speech = Speech.default })
  ctx.effect(() => () => voice.fiber.dispose())
  const speech = voice.get('speechToText'); assert.ok(speech)
  const entered = Promise.withResolvers(), release = Promise.withResolvers()
  let unregister
  ctx.effect(() => {
    unregister = speech.register({ info: { id: 'local', name: 'Local', location: 'host-local', languages: ['auto'] },
      transcribe: async () => { entered.resolve(); return release.promise } })
    return unregister
  })
  const transcript = { text: 'External recognition completed.', audioSeconds: 1, inferenceSeconds: 0.1 }
  ctx.effect(() => () => release.resolve(transcript))
  class Adapter extends LlmAdapter {
    async resolveModel(provider, model) {
      return { provider, id: model, name: model, context: { contextWindow: 100000 }, defaultMaxTokens: 512 }
    }
    async *stream(_options, dispatchRequest) {
      await dispatchRequest(async () => {})
      const active = speech.transcribe(speech.resolve({ audio: new Uint8Array([1, 2]) }), new AbortController().signal)
        .then(value => ({ value }), error => ({ error }))
      let removing, following, finished = false
      try {
        await Promise.race([entered.promise, active.then(() => { throw new Error('Recognition did not reach its controlled wait.') })])
        removing = unregister()
        const entry = [...voice.get('loader').entries()].find(row => row.options.id === 'speech'); assert.ok(entry)
        following = (phase === 'duplicate' ? unregister() : entry.fiber.dispose()).then(() => { finished = true })
        await yieldEventLoop()
        const closedBeforeRelease = finished, rosterRemoved = speech.listProviders().length === 0
        release.resolve(transcript)
        const outcome = await active
        await Promise.all([removing, following])
        const proof = { closedBeforeRelease, rosterRemoved, finishedAfterRelease: finished, acceptedWorkRejected: 'error' in outcome }
        yield { type: 'block-end', index: 0, block: { type: 'text', text: JSON.stringify(proof) } }
        yield { type: 'finish', reason: { kind: 'stop' } }
      } finally { release.resolve(transcript); await Promise.allSettled([active, removing, following]) }
    }
  }
  ctx.effect(() => ctx.llm.registerAdapter(['speech-removal-fixture'], new Adapter()))
  ctx.provide('speechRemovalReady', true)
}
