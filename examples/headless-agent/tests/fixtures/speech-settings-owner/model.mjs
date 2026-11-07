/** Actual Loader/FileSettings speech preferences survive provider withdrawal and replacement. */
import assert from 'node:assert/strict'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { setImmediate as yieldEventLoop } from 'node:timers/promises'
import { boot } from '@deepseek-ai/dsh-app-boot'
import { LlmAdapter } from '@deepseek-ai/dsh-llm'

export const inject = ['llm']

/** Compose the real preference capability in an owned Host and expose its outcome through the SDK turn. */
export async function apply(ctx) {
  const phase = process.env.DSH_SPEECH_SETTINGS_PHASE
  assert.ok(['withdrawn', 'replaced', 'write', 'persist-withdrawn'].includes(phase))
  const face = process.env.DSH_EXAMPLE_MODE === 'src' ? 'src/index.ts' : 'lib/index.js'
  const Speech = await import(new URL(`../../../../../packages/experimental/speech-to-text/${face}`, import.meta.url))
  const Settings = await import(new URL(`../../../../../packages/settings/settings-file/${face}`, import.meta.url))
  const entered = Promise.withResolvers(), release = Promise.withResolvers()
  let blocked = false
  class DelayedSettings extends Settings.default {
    async persist(namespace, section) {
      if (blocked) { entered.resolve(); await release.promise }
      await super.persist(namespace, section)
    }
  }
  const directory = join(process.cwd(), 'speech-settings-owner')
  await mkdir(directory)
  const first = join(directory, 'first.json'), second = join(directory, 'second.json'), config = join(directory, 'cordis.yml')
  await writeFile(config, JSON.stringify([
    { id: 'speech-settings', name: 'cordis:settings', config: { path: first, watch: false } },
    { id: 'speech', name: 'cordis:speech', config: { defaultProvider: 'local', language: 'auto' } },
  ]))
  const voice = await boot('speech-settings-owner', config, [], host => {
    Object.assign(host.loader.builtins, { settings: phase === 'persist-withdrawn' ? DelayedSettings : Settings.default,
      speech: Speech.default })
  })
  ctx.effect(() => () => voice.fiber.dispose())
  ctx.effect(() => () => release.resolve())
  const speech = voice.get('speechToText')
  assert.ok(speech)
  voice.effect(() => speech.register({ info: { id: 'local', name: 'Local', location: 'host-local', languages: ['auto', 'zh', 'en', 'ja'] },
    transcribe: async () => { throw new Error('Saving preferences must not start recognition.') } }))
  class Adapter extends LlmAdapter {
    async resolveModel(provider, model) {
      return { provider, id: model, name: model, context: { contextWindow: 100000 }, defaultMaxTokens: 512 }
    }
    async *stream(_options, dispatchRequest) {
      await dispatchRequest(async () => {})
      await speech.configure({ language: 'zh' })
      const entry = [...voice.get('loader').entries()].find(row => row.options.id === 'speech-settings')
      assert.ok(entry)
      let result
      if (phase === 'persist-withdrawn') {
        blocked = true
        const saving = speech.configure({ language: 'ja' }).then(() => ({ acknowledged: true }), error => ({ error }))
        let closing
        try {
          await Promise.race([entered.promise, saving.then(() => { throw new Error('Preferences did not reach their controlled write.') })])
          closing = entry.update({ disabled: true })
          await yieldEventLoop()
          const language = speech.snapshot().selection.language
          release.resolve()
          const outcome = await saving
          await closing
          result = { acknowledged: 'acknowledged' in outcome, language,
            stored: JSON.parse(await readFile(first, 'utf8'))['speech-to-text'].language }
        } finally { release.resolve(); await Promise.allSettled([saving, closing]) }
      } else if (phase === 'withdrawn') {
        await entry.update({ disabled: true })
        let writeRefused = false
        try { await speech.configure({ language: 'en' }) }
        catch (error) { writeRefused = error.message === 'Speech selection requires the settings service' }
        result = { language: speech.snapshot().selection.language, writeRefused }
      } else {
        await entry.update({ disabled: true })
        await writeFile(second, JSON.stringify({ 'speech-to-text': { defaultProvider: 'local', language: 'en' } }))
        await entry.update({ disabled: false, config: { path: second, watch: false } })
        await entry.fiber.await()
        if (phase === 'replaced') result = { language: speech.snapshot().selection.language,
          resolvedLanguage: speech.resolve({ audio: new Uint8Array() }).language }
        else {
          try {
            await speech.configure({ language: 'ja' })
            result = { first: JSON.parse(await readFile(first, 'utf8'))['speech-to-text'].language,
              second: JSON.parse(await readFile(second, 'utf8'))['speech-to-text'].language }
          } catch (error) { result = { error: error.message.split(':')[0] } }
        }
      }
      yield { type: 'block-end', index: 0, block: { type: 'text', text: JSON.stringify(result) } }
      yield { type: 'finish', reason: { kind: 'stop' } }
    }
  }
  ctx.effect(() => ctx.llm.registerAdapter(['speech-settings-fixture'], new Adapter()))
  ctx.provide('speechSettingsOwnerReady', true)
}
