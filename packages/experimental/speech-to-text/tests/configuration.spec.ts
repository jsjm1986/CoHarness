/** Speech preferences persisted through the profile's Loader and Settings services. */
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setImmediate as yieldEventLoop } from 'node:timers/promises'
import { Context } from '@deepseek-ai/cordis'
import type { SettingsNamespace } from '@deepseek-ai/dsh-settings'
import { expect, it, vi } from 'vitest'
import { boot, initProfile, readProfilePatches, type ProfileContext } from '@deepseek-ai/dsh-app-boot'
import FileSettingsProvider from '@deepseek-ai/dsh-settings-file'
import SpeechToText from '../src/index.ts'
import type { SpeechProviderId, SpeechSnapshot } from '../src/types.ts'

it('refuses a speech preference acknowledgement after its Settings binding withdraws during persistence', async () => {
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'dsh-speech-settings-write-'))), ctx = new Context()
  const entered = Promise.withResolvers<undefined>(), release = Promise.withResolvers<undefined>()
  let blocked = false, saving: Promise<unknown> | undefined, closing: Promise<void> | undefined
  class DelayedSettings extends FileSettingsProvider {
    protected override async persist(ns: SettingsNamespace, section: Record<string, unknown>): Promise<void> {
      if (blocked) { entered.resolve(undefined); await release.promise }
      await super.persist(ns, section)
    }
  }
  try {
    const file = join(home, 'settings.json'), settings = ctx.plugin(DelayedSettings, { path: file, watch: false }); await settings
    await ctx.plugin(SpeechToText, { defaultProvider: 'local', language: 'auto' })
    const speech = ctx.get('speechToText')!
    speech.register({ info: { id: 'local' as SpeechProviderId, name: 'Local', location: 'host-local', languages: ['auto', 'zh', 'ja'] },
      transcribe: async () => { throw new Error('Saving preferences must not start recognition.') } })
    await speech.configure({ language: 'zh' })
    blocked = true
    saving = speech.configure({ language: 'ja' }).then(() => ({ saved: true }), (error: unknown) => ({ error }))
    await Promise.race([entered.promise, saving.then(() => { throw new Error('Speech preferences did not reach persistence.') })])
    closing = settings.dispose()
    await yieldEventLoop()
    expect(speech.snapshot().selection.language).toBe('auto')
    release.resolve(undefined)
    expect(await saving).toMatchObject({ error: { message: 'Speech settings provider changed while saving preferences' } })
    await closing
    expect(JSON.parse(readFileSync(file, 'utf8')) as unknown).toMatchObject({ 'speech-to-text': { language: 'ja' } })
  } finally {
    release.resolve(undefined)
    await Promise.allSettled([saving, closing])
    try { await ctx.fiber.dispose() } finally { rmSync(home, { recursive: true, force: true }) }
  }
})

it('notifies speech observers when Settings withdraws and returns', async () => {
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'dsh-speech-settings-follow-'))), ctx = new Context()
  const controller = new AbortController(), first = join(home, 'first.json'), second = join(home, 'second.json')
  let observer: AsyncIterator<SpeechSnapshot, void> | undefined, pending: Promise<unknown> | undefined
  try {
    const original = ctx.plugin(FileSettingsProvider, { path: first, watch: false }); await original
    await ctx.plugin(SpeechToText, { defaultProvider: 'local', language: 'auto' })
    const speech = ctx.get('speechToText')!
    speech.register({ info: { id: 'local' as SpeechProviderId, name: 'Local', location: 'host-local', languages: ['auto', 'zh', 'en'] },
      transcribe: async () => { throw new Error('Following preferences must not transcribe audio.') } })
    await speech.configure({ language: 'zh' })
    observer = speech.follow(controller.signal)[Symbol.asyncIterator]()
    const initial = await observer.next()
    if (initial.done) throw new Error('Speech observer ended before its initial snapshot.')
    expect(initial.value.selection.language).toBe('zh')
    let observed: SpeechSnapshot | undefined
    pending = observer.next().then((item) => { if (!item.done) observed = item.value })
    await original.dispose()
    await vi.waitFor(() => { expect(observed?.selection.language).toBe('auto') }, { timeout: 5000 })
    observed = undefined
    pending = observer.next().then((item) => { if (!item.done) observed = item.value })
    writeFileSync(second, JSON.stringify({ 'speech-to-text': { defaultProvider: 'local', language: 'en' } }))
    await ctx.plugin(FileSettingsProvider, { path: second, watch: false })
    await vi.waitFor(() => { expect(observed?.selection.language).toBe('en') }, { timeout: 5000 })
  } finally {
    controller.abort()
    await pending
    await observer?.return?.()
    try { await ctx.fiber.dispose() } finally { rmSync(home, { recursive: true, force: true }) }
  }
}, 15_000)

it.each(['withdrawn', 'replaced', 'write'] as const)('rebinds speech preferences after the Settings provider is %s', async (phase) => {
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'dsh-speech-settings-owner-'))), ctx = new Context()
  const first = join(home, 'first.json'), second = join(home, 'second.json')
  let settings = ctx.plugin(FileSettingsProvider, { path: first, watch: false })
  try {
    await settings
    await ctx.plugin(SpeechToText, { defaultProvider: 'local', language: 'auto' })
    const speech = ctx.get('speechToText')!
    speech.register({ info: { id: 'local' as SpeechProviderId, name: 'Local', location: 'host-local', languages: ['auto', 'zh', 'en', 'ja'] },
      transcribe: async () => { throw new Error('Preference changes must not start recognition.') } })
    await speech.configure({ language: 'zh' })
    expect(speech.snapshot().selection.language).toBe('zh')
    await settings.dispose()
    if (phase === 'withdrawn') {
      expect(speech.snapshot().selection).toEqual({ providerId: 'local', language: 'auto' })
      await expect(speech.configure({ language: 'en' })).rejects.toThrow('settings service')
      return
    }
    writeFileSync(second, JSON.stringify({ 'speech-to-text': { defaultProvider: 'local', language: 'en' } }))
    settings = ctx.plugin(FileSettingsProvider, { path: second, watch: false })
    await settings
    if (phase === 'replaced') {
      expect(speech.snapshot().selection).toEqual({ providerId: 'local', language: 'en' })
      expect(speech.resolve({ audio: new Uint8Array() }).language).toBe('en')
    } else {
      await speech.configure({ language: 'ja' })
      expect(JSON.parse(readFileSync(second, 'utf8')) as unknown).toMatchObject({ 'speech-to-text': { language: 'ja' } })
      expect(JSON.parse(readFileSync(first, 'utf8')) as unknown).toMatchObject({ 'speech-to-text': { language: 'zh' } })
    }
  } finally { try { await ctx.fiber.dispose() } finally { rmSync(home, { recursive: true, force: true }) } }
})

it('saves language and provider preferences without remounting and restores them at restart', async () => {
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'dsh-speech-configuration-')))
  let ctx: Awaited<ReturnType<typeof boot>> | undefined
  try {
    const dir = join(home, 'profiles', 'test')
    initProfile(dir, ['test-bundle'])
    const bundle = join(dir, 'node_modules', 'test-bundle')
    mkdirSync(bundle, { recursive: true })
    writeFileSync(join(home, 'package.json'), '{"name":"test-installation"}\n')
    writeFileSync(join(bundle, 'package.json'), JSON.stringify({ name: 'test-bundle', version: '1.0.0', dsh: { bundle: { patch: 'cordis.patch.yml' } } }))
    // dshHome pins the provider's settings.yaml into the temporary home; watch stays off so no
    // filesystem observer outlives the test on shared CI hosts.
    writeFileSync(join(bundle, 'cordis.patch.yml'), `- insert:
    - id: settings
      name: cordis:settings
      config:
        dshHome: ${JSON.stringify(home)}
        watch: false
    - id: speech-to-text
      name: cordis:speech
      config:
        defaultProvider: sensevoice-local
`)
    writeFileSync(join(dir, 'cordis.yml'), '[]\n')
    const profile: ProfileContext = {
      name: 'test', startedBundles: ['test-bundle'], dir, patchPath: join(dir, 'cordis.patch.yml'),
      installAnchor: join(home, 'package.json'), cwd: home, home, overlays: [], telemetryDisabledEnv: undefined,
    }
    const start = () => boot('test', join(dir, 'cordis.yml'), readProfilePatches('test', profile), (root) => {
      root.provide('profileContext', profile)
      Object.assign(root.loader.builtins, { settings: FileSettingsProvider, speech: SpeechToText })
    })
    ctx = await start()
    const speech = ctx.get('speechToText')!
    const languages = ['auto', 'zh', 'en', 'yue', 'ja', 'ko']
    for (const id of ['sensevoice-local', 'another-provider']) speech.register({
      info: { id: id as SpeechProviderId, name: id, location: 'host-local', languages },
      transcribe: async () => { throw new Error('Changing preferences must not transcribe audio') },
    })
    for (const language of [...languages, 'zh']) {
      await speech.configure({ language })
      expect(speech.snapshot().selection).toEqual({ providerId: 'sensevoice-local', language })
    }
    await speech.configure({ providerId: 'another-provider' as SpeechProviderId })
    expect(speech.snapshot().selection).toEqual({ providerId: 'another-provider', language: 'zh' })
    const saved = readFileSync(join(home, 'settings.yaml'), 'utf8')
    expect(saved).toContain('speech-to-text')
    expect(saved).toContain('defaultProvider: another-provider')
    expect(saved).toContain('language: zh')
    await ctx.fiber.dispose()
    ctx = await start()
    expect(ctx.get('speechToText')!.snapshot().selection).toEqual({ providerId: 'another-provider', language: 'zh' })
  } finally {
    try { await ctx?.fiber.dispose() } finally { rmSync(home, { recursive: true, force: true }) }
  }
})
