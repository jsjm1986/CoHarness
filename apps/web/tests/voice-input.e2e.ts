/** Browser dictation submits only reviewed text through the ordinary recorded Session flow. */
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium, type Browser } from 'playwright'
import { expect, it, onTestFinished, vi } from 'vitest'
import type { SpeechInput, SpeechPreparationState, SpeechProviderId } from '@deepseek-ai/dsh-experimental-speech-to-text/types'
import type {} from '@deepseek-ai/dsh-experimental-speech-to-text'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import {
  captureStableAria, fixtureUserPrompts, launchWebScaffold, selectedSessionFixture, webSnapshotMode, watchConsole,
  type WebScaffold,
} from './scaffold.ts'
import { completionBarrier, connectFreshWorkspace } from './support.ts'
import { auditWorkflowState, compareWorkflowGolden, newWorkflowPage, workflowMatrixEnabled } from './workflow-responsive-state.ts'
import { responsiveBrowser, responsiveBrowserName } from './responsive-browser.ts'

const fixturePath = fileURLToPath(new URL('../../../snapshots/web/fresh-round-trip/session.v7.jsonl', import.meta.url))
const expected = fileURLToPath(new URL('../../../snapshots/web/voice-input/ui.expected.md', import.meta.url))
const interruptedExpected = fileURLToPath(new URL('../../../snapshots/web/voice-input/interrupted.expected.md', import.meta.url))
const recordingExpected = fileURLToPath(new URL('../../../snapshots/web/voice-input/recording.expected.md', import.meta.url))
const bundle = fileURLToPath(new URL('../../../packages/experimental/voice-input-bundle', import.meta.url))

it.skipIf(webSnapshotMode() === 'record' || responsiveBrowserName !== 'chromium')('guides voice setup, records from standby and submits only the reviewed transcript through Session replay', async () => {
  const scratch = await mkdtemp(join(tmpdir(), 'dsh-voice-browser-'))
  const transcriptRelease = completionBarrier()
  const cancelledTranscriptRelease = completionBarrier()
  const resources: { scaffold?: WebScaffold; browser?: Browser } = {}
  onTestFinished(async () => {
    transcriptRelease.resolve()
    cancelledTranscriptRelease.resolve()
    try { await resources.browser?.close() } finally {
      try { await resources.scaffold?.close() } finally { await rm(scratch, { recursive: true, force: true }) }
    }
  })
  const overlay = join(scratch, 'voice.patch.yml')
  await writeFile(overlay, '- id: speech-to-text-sensevoice\n  disabled: true\n')
  const fixture = await selectedSessionFixture(fixturePath)
  const prompt = fixtureUserPrompts(await readFile(fixture, 'utf8'))[0]!
  const prefix = 'Use the bash tool to '
  const scaffold = await launchWebScaffold({
    extraInstallAnchors: [join(bundle, 'package.json')],
    extraOverlayPath: [join(bundle, 'cordis.patch.yml'), overlay], replayFixture: fixture,
  })
  resources.scaffold = scaffold
  const recognize = vi.fn(async (input: SpeechInput, signal: AbortSignal) => {
    signal.throwIfAborted()
    expect(Buffer.from(input.audio).subarray(0, 4).toString()).toBe('RIFF')
    expect(input.audio.byteLength).toBeGreaterThan(44)
    await transcriptRelease.promise
    return { text: prompt.slice(prefix.length), audioSeconds: 1, inferenceSeconds: 0.1 }
  })
  let preparation: SpeechPreparationState = { phase: 'unprepared' }
  const readinessListeners = new Set<() => void>()
  await scaffold.ctx.plugin({ inject: ['speechToText'], apply(ctx) {
    ctx.effect(() => ctx.speechToText.register({
      info: { id: 'sensevoice-local' as SpeechProviderId, name: 'Recorded recognizer', location: 'host-local', languages: ['auto'] },
      preparation: {
        snapshot: () => preparation,
        subscribe: (listener) => { readinessListeners.add(listener); return () => { readinessListeners.delete(listener) } },
        prepare: () => { throw new Error('Cached resources must allow recording without preparation') },
        cancel: async () => {},
      },
      transcribe: recognize,
    }))
  } })
  let messages = 0
  scaffold.ctx.on('session/event', (_session, event: SessionEvent) => {
    if (event.type === 'user/message' && event.data.source.kind === 'user') messages++
  })
  const browser = await chromium.launch({ args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'] })
  resources.browser = browser
  const page = await newWorkflowPage(browser), tripwire = watchConsole(page)
  await page.addInitScript(() => {
    const holder = window as Window & {
      voiceTestStreams?: MediaStream[]
      voiceTestExcluded?: string[]
      voiceTestNames?: Record<string, string>
    }
    holder.voiceTestStreams = []
    holder.voiceTestExcluded = []
    holder.voiceTestNames = {}
    const enumerateDevices = navigator.mediaDevices.enumerateDevices.bind(navigator.mediaDevices)
    navigator.mediaDevices.enumerateDevices = async () => (await enumerateDevices())
      .filter(device => !holder.voiceTestExcluded!.includes(device.deviceId))
      .map((device) => {
        const label = holder.voiceTestNames![device.deviceId]
        if (label) Object.defineProperty(device, 'label', { value: label })
        return device
      })
    const getUserMedia = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices)
    navigator.mediaDevices.getUserMedia = async (constraints) => {
      const stream = await getUserMedia(constraints)
      holder.voiceTestStreams!.push(stream)
      return stream
    }
  })
  await page.goto(scaffold.authenticatedUrl)
  await connectFreshWorkspace(page, scaffold.workspaceCwd)
  const input = page.locator('[data-composer-card] textarea:enabled'), mic = page.getByRole('button', { name: 'Start recording', exact: true })
  const auditCapture = async (state: string, phase: 'recording' | 'transcribing' | 'feedback' | 'idle'): Promise<void> => {
    const verify = async (): Promise<void> => {
      const activity = page.locator('[data-voice-activity]')
      if (phase === 'idle') await expect.poll(() => activity.count()).toBe(0)
      else await expect.poll(() => activity.getAttribute('data-voice-activity')).toBe(phase)
    }
    await verify()
    await auditWorkflowState(page, 'voice', state, page.locator('[data-composer-card]'), [], undefined, verify)
  }
  const setupMic = page.getByRole('button', { name: 'Open voice input setup', exact: true })
  await input.fill(prefix)
  await setupMic.click()
  const setup = page.getByRole('dialog', { name: 'Set up voice input before recording', exact: true })
  await setup.waitFor()
  await auditWorkflowState(page, 'voice', 'setup', setup)
  const setupAction = setup.getByRole('button', { name: 'Go to setup', exact: true })
  await expect.poll(() => setupAction.evaluate(element => element === document.activeElement)).toBe(true)
  await page.keyboard.type('NoDraftEdits')
  expect(await input.inputValue()).toBe(prefix)
  expect(messages).toBe(0)
  await page.keyboard.press('Tab')
  expect(await setup.getByRole('button', { name: 'Cancel', exact: true }).evaluate(element => element === document.activeElement)).toBe(true)
  await page.keyboard.press('Shift+Tab')
  expect(await setupAction.evaluate(element => element === document.activeElement)).toBe(true)
  await compareWorkflowGolden(fileURLToPath(new URL('../../../snapshots/web/voice-input/setup.expected.md', import.meta.url)),
    await captureStableAria(page, '[role="dialog"]', scaffold.workspaceCwd), webSnapshotMode())
  await setup.getByRole('button', { name: 'Later', exact: true }).click()
  expect(await setup.count()).toBe(0)
  expect(await input.evaluate(element => element === document.activeElement)).toBe(true)
  expect(recognize).not.toHaveBeenCalled()
  preparation = { phase: 'checking', step: 'check', startedAt: 0 }
  for (const listener of readinessListeners) listener()
  await setupMic.click()
  const unavailable = page.getByRole('dialog', { name: 'Speech recognition is not ready', exact: true })
  await unavailable.waitFor()
  await auditWorkflowState(page, 'voice', 'unavailable', unavailable)
  await compareWorkflowGolden(fileURLToPath(new URL('../../../snapshots/web/voice-input/unavailable.expected.md', import.meta.url)),
    await captureStableAria(page, '[role="dialog"]', scaffold.workspaceCwd), webSnapshotMode())
  await page.setViewportSize({ width: 420, height: 900 })
  const dialogBox = await unavailable.boundingBox()
  expect(dialogBox!.x).toBeGreaterThanOrEqual(0)
  expect(dialogBox!.x + dialogBox!.width).toBeLessThanOrEqual(420)
  await page.keyboard.press('Escape')
  await unavailable.waitFor({ state: 'hidden' })
  expect(await input.evaluate(element => element === document.activeElement)).toBe(true)
  expect(await input.inputValue()).toBe(prefix)
  preparation = { phase: 'failed', message: 'Model preparation failed' }
  for (const listener of readinessListeners) listener()
  await setupMic.click()
  const detailsAction = unavailable.getByRole('button', { name: 'Open voice settings', exact: true })
  await expect.poll(() => detailsAction.evaluate(element => element === document.activeElement)).toBe(true)
  await page.keyboard.press('Enter')
  await page.setViewportSize({ width: 1280, height: 900 })
  await page.locator('[data-plugin-item-detail="speech-to-text"]')
    .getByRole('button', { name: 'Retry preparation', exact: true }).waitFor()
  await auditWorkflowState(page, 'voice', 'preparation-failed', page.locator('[data-plugin-item-detail="speech-to-text"]'))
  expect(await unavailable.count()).toBe(0)
  expect(messages).toBe(0)
  expect(recognize).not.toHaveBeenCalled()
  preparation = { phase: 'standby' }
  for (const listener of readinessListeners) listener()
  const devicePicker = page.getByRole('combobox', { name: 'Input device', exact: true })
  const level = page.getByRole('img', { name: 'Microphone input level', exact: true })
  await level.waitFor()
  const devices = await page.evaluate(async () => (await navigator.mediaDevices.enumerateDevices())
    .filter(device => device.kind === 'audioinput' && device.deviceId !== 'default'))
  const selectedDevice = devices[0]!
  await devicePicker.selectOption(selectedDevice.deviceId)
  await expect.poll(() => devicePicker.inputValue()).toBe(selectedDevice.deviceId)
  await auditWorkflowState(page, 'voice', 'device-selected', page.locator('[data-plugin-item-detail="speech-to-text"]'))
  await expect.poll(() => page.evaluate(() => {
    const streams = (window as Window & { voiceTestStreams?: MediaStream[] }).voiceTestStreams!
    return streams.filter(stream => stream.getTracks().some(track => track.readyState === 'live')).length
  })).toBe(1)
  await compareWorkflowGolden(fileURLToPath(new URL('../../../snapshots/web/voice-input/device.expected.md', import.meta.url)),
    await captureStableAria(page, '[data-voice-input-device]', scaffold.workspaceCwd), webSnapshotMode())
  const acquisitions = await page.evaluate(() => (window as Window & { voiceTestStreams?: MediaStream[] }).voiceTestStreams!.length)
  const otherDevice = devices[1]!
  for (const excluded of [[otherDevice.deviceId], []]) {
    await page.evaluate((ids) => {
      (window as Window & { voiceTestExcluded?: string[] }).voiceTestExcluded = ids
      navigator.mediaDevices.dispatchEvent(new Event('devicechange'))
    }, excluded)
    await expect.poll(() => page.getByRole('option', { name: otherDevice.label, exact: true }).count()).toBe(excluded.length ? 0 : 1)
    expect(await page.evaluate(() => (window as Window & { voiceTestStreams?: MediaStream[] }).voiceTestStreams!.length)).toBe(acquisitions)
    await level.waitFor()
  }
  await page.evaluate((id) => {
    const holder = window as Window & { voiceTestExcluded?: string[]; voiceTestStreams?: MediaStream[] }
    holder.voiceTestExcluded = [id]
    const track = holder.voiceTestStreams!.at(-1)!.getAudioTracks()[0]!
    track.stop(); track.dispatchEvent(new Event('ended'))
    navigator.mediaDevices.dispatchEvent(new Event('devicechange'))
  }, selectedDevice.deviceId)
  const missing = page.getByRole('option', { name: `${selectedDevice.label} — Unavailable`, exact: true })
  await expect.poll(() => missing.count()).toBe(1)
  expect(await missing.isDisabled()).toBe(true)
  await level.waitFor({ state: 'hidden' })
  expect(await devicePicker.evaluate(element => (element as HTMLSelectElement).selectedOptions[0]?.textContent)).toContain('Unavailable')
  await auditWorkflowState(page, 'voice', 'device-missing', page.locator('[data-plugin-item-detail="speech-to-text"]'))
  await compareWorkflowGolden(fileURLToPath(new URL('../../../snapshots/web/voice-input/device-missing.expected.md', import.meta.url)),
    await captureStableAria(page, '[data-voice-input-device]', scaffold.workspaceCwd), webSnapshotMode())
  await page.evaluate(() => {
    (window as Window & { voiceTestExcluded?: string[] }).voiceTestExcluded = []
    navigator.mediaDevices.dispatchEvent(new Event('devicechange'))
  })
  await expect.poll(() => devicePicker.evaluate(element => (element as HTMLSelectElement).selectedOptions[0]?.textContent))
    .not.toContain('Unavailable')
  await level.waitFor()
  expect(await page.evaluate(() => (window as Window & { voiceTestStreams?: MediaStream[] })
    .voiceTestStreams!.length)).toBe(acquisitions + 1)
  await devicePicker.blur()
  await level.waitFor()
  const longName = 'USB studio microphone — conference room recording input'
  await page.evaluate(({ id, label }) => {
    (window as Window & { voiceTestNames?: Record<string, string> }).voiceTestNames![id] = label
    navigator.mediaDevices.dispatchEvent(new Event('devicechange'))
  }, { id: selectedDevice.deviceId, label: longName })
  await expect.poll(() => devicePicker.evaluate(element => (element as HTMLSelectElement).selectedOptions[0]?.textContent)).toBe(longName)
  await auditWorkflowState(page, 'voice', 'device-long-name', page.locator('[data-plugin-item-detail="speech-to-text"]'))
  await page.setViewportSize({ width: 360, height: 900 })
  await level.waitFor()
  await devicePicker.scrollIntoViewIfNeeded()
  await compareWorkflowGolden(fileURLToPath(new URL('../../../snapshots/web/voice-input/device-long.expected.md', import.meta.url)),
    await captureStableAria(page, '[data-voice-input-device]', scaffold.workspaceCwd), webSnapshotMode())
  const pickerBounds = (await devicePicker.boundingBox())!, levelBounds = (await level.boundingBox())!
  expect(levelBounds.x).toBeGreaterThan(pickerBounds.x + pickerBounds.width / 2)
  expect(levelBounds.x + levelBounds.width).toBeLessThan(pickerBounds.x + pickerBounds.width)
  await page.setViewportSize({ width: 1280, height: 900 })
  // A bare New Session mints a fresh Session+Agent asynchronously; until it
  // binds, the composer still shows the previous session's draft, so a typed
  // draft would land on the wrong session. The previous draft is the seeded
  // prefix, and an emptied textarea marks the fresh session's binding.
  await page.getByRole('button', { name: 'New session', exact: true }).last().click()
  await expect.poll(() => input.inputValue(), { timeout: 15_000 }).toBe('')
  await mic.waitFor()
  await expect.poll(() => page.evaluate(() => (window as Window & { voiceTestStreams?: MediaStream[] }).voiceTestStreams!
    .every(stream => stream.getTracks().every(track => track.readyState === 'ended')))).toBe(true)
  // The second swap needs a distinguishing draft: this session's textbox is
  // already empty, so seed a marker the next fresh binding must clear.
  await input.fill('pending-swap')
  await page.getByRole('button', { name: 'Plugins', exact: true }).click()
  await page.locator('[data-plugin-item="speech-to-text"]').waitFor()
  expect(await page.locator('[data-plugin-item-detail]').count()).toBe(0)
  // Plugins is a global panel that owns the browsing region (the composer
  // unmounts); the shell's New Session returns to the Conversation and mints
  // a fresh Session+Agent, so the next enabled textarea is the new binding.
  await page.getByRole('button', { name: 'New session', exact: true }).last().click()
  await expect.poll(() => input.inputValue(), { timeout: 15_000 }).toBe('')
  await mic.waitFor()
  const micBox = await mic.boundingBox(), modelBox = await page.getByRole('button', { name: /^Select model, current/ }).boundingBox()
  const sendBox = await page.getByRole('button', { name: 'Send message', exact: true }).boundingBox()
  expect(micBox!.x).toBeLessThan(modelBox!.x)
  expect(micBox!.x).toBeLessThan(sendBox!.x)
  await input.fill(prefix)
  await mic.click()
  await page.getByRole('button', { name: 'Stop and transcribe', exact: true }).waitFor()
  await auditCapture('recording', 'recording')
  expect(await page.evaluate(() => (window as Window & { voiceTestStreams?: MediaStream[] }).voiceTestStreams!
    .at(-1)!.getAudioTracks()[0]!.getSettings().deviceId)).toBe(selectedDevice.deviceId)
  await compareWorkflowGolden(recordingExpected,
    await captureStableAria(page, '[data-composer-card]', scaffold.workspaceCwd), webSnapshotMode())
  expect(await page.getByRole('dialog').count()).toBe(0)
  // Controlled fake microphone audio occupies this recording interval; it is not a readiness wait.
  await page.waitForTimeout(300)
  await page.getByRole('button', { name: 'Stop and transcribe', exact: true }).click()
  await expect.poll(() => recognize.mock.calls.length).toBe(1)
  await auditCapture('transcribing', 'transcribing')
  expect(await input.inputValue()).toBe(prefix)
  expect(messages).toBe(0)
  transcriptRelease.resolve()
  await expect.poll(() => input.inputValue()).toBe(prompt)
  expect(recognize).toHaveBeenCalledOnce()
  expect(messages).toBe(0)
  await auditCapture('review-transcript', 'idle')
  await compareWorkflowGolden(expected, await captureStableAria(page, '[data-conversation-region="chat"]', scaffold.workspaceCwd), webSnapshotMode())
  const settled = scaffold.whenTurnSettled()
  await input.press('Enter')
  await settled
  await page.getByText('DONE', { exact: true }).waitFor()
  const meter = page.getByRole('button', { name: /% of context used/ })
  await meter.waitFor()
  const contextUsage = await meter.getAttribute('aria-label')
  for (const width of [1280, 420]) {
    await page.setViewportSize({ width, height: 900 })
    await expect.poll(async () => {
      const micRect = await mic.boundingBox(), meterRect = await meter.boundingBox()
      return micRect !== null && meterRect !== null
    }).toBe(true)
    await meter.click()
    await page.getByRole('dialog', { name: 'of context used', exact: true }).waitFor()
    await page.keyboard.press('Escape')
  }
  if (!workflowMatrixEnabled) {
    await mic.hover()
    await page.getByRole('tooltip', { name: 'Dictate', exact: true }).waitFor()
  }
  await mic.click()
  const stop = page.getByRole('button', { name: 'Stop and transcribe', exact: true })
  await stop.waitFor()
  for (const width of [1280, 420]) {
    await page.setViewportSize({ width, height: 900 })
    const waveformBox = await page.getByRole('img', { name: 'Recording…', exact: true }).boundingBox()
    const stopBox = await stop.boundingBox(), cancelBox = await page.getByRole('button', { name: 'Cancel', exact: true }).boundingBox()
    expect(waveformBox!.height).toBeLessThanOrEqual(Math.min(stopBox!.height, cancelBox!.height))
  }
  await input.hover()
  await page.keyboard.press('Escape')
  await mic.waitFor()
  await meter.waitFor()
  await meter.click()
  await page.getByRole('dialog', { name: 'of context used', exact: true }).waitFor()
  await page.keyboard.press('Escape')
  await mic.click()
  await stop.waitFor()
  await page.evaluate(() => {
    const track = (window as Window & { voiceTestStreams?: MediaStream[] }).voiceTestStreams!.at(-1)!.getAudioTracks()[0]!
    track.stop(); track.dispatchEvent(new Event('ended'))
  })
  await page.getByRole('button', { name: 'Record again', exact: true }).waitFor()
  await auditCapture('recording-interrupted', 'feedback')
  await page.evaluate(() => { navigator.mediaDevices.dispatchEvent(new Event('devicechange')) })
  expect(await stop.count()).toBe(0)
  await meter.waitFor()
  expect(await meter.getAttribute('aria-label')).toBe(contextUsage)
  await compareWorkflowGolden(interruptedExpected,
    await captureStableAria(page, '[data-composer-tool-layout]', scaffold.workspaceCwd), webSnapshotMode())
  expect(recognize).toHaveBeenCalledOnce()
  await page.getByRole('button', { name: 'Record again', exact: true }).click()
  await stop.waitFor()
  await auditCapture('recording-retry', 'recording')
  await page.keyboard.press('Escape')
  await mic.waitFor()
  const retainedDraft = 'Keep this draft while voice input recovers.'
  await input.fill(retainedDraft)
  recognize.mockRejectedValueOnce(new Error('Recognition service unavailable'))
  await mic.click()
  await stop.waitFor()
  // Capture a non-empty fake-device WAV before sending it to the failing provider.
  await page.waitForTimeout(300)
  await stop.click()
  await page.getByRole('status').filter({ hasText: 'Recognition service unavailable' }).waitFor()
  await auditCapture('transcription-failed', 'feedback')
  expect(await input.inputValue()).toBe(retainedDraft)
  expect(recognize).toHaveBeenCalledTimes(2)
  recognize.mockImplementationOnce(async () => {
    await cancelledTranscriptRelease.promise
    return { text: 'Late cancelled transcript', audioSeconds: 1, inferenceSeconds: 0.1 }
  })
  await page.getByRole('button', { name: 'Record again', exact: true }).click()
  await stop.waitFor()
  await page.waitForTimeout(300)
  await stop.click()
  await expect.poll(() => recognize.mock.calls.length).toBe(3)
  const cancelledSignal = recognize.mock.calls[2]![1]
  expect(cancelledSignal.aborted).toBe(false)
  await auditCapture('transcribing-cancellable', 'transcribing')
  await page.locator('[data-voice-activity]').getByRole('button', { name: 'Cancel', exact: true }).click()
  await mic.waitFor()
  await expect.poll(() => cancelledSignal.aborted).toBe(true)
  cancelledTranscriptRelease.resolve()
  const lateResult = recognize.mock.results[2]
  if (lateResult?.type !== 'return') throw new Error('Cancelled transcription did not start')
  await lateResult.value
  await auditCapture('cancelled-transcription-retains-draft', 'idle')
  expect(await input.inputValue()).toBe(retainedDraft)
  await expect.poll(() => page.evaluate(() => (window as Window & { voiceTestStreams?: MediaStream[] }).voiceTestStreams!
    .every(stream => stream.getTracks().every(track => track.readyState === 'ended')))).toBe(true)
  expect(messages).toBe(1)
  expect(tripwire.pageErrors).toEqual([])
}, workflowMatrixEnabled ? 420_000 : 120_000)

it.skipIf(webSnapshotMode() === 'record')('keeps every recognizer preparation state readable without downloading model resources', async () => {
  const scratch = await mkdtemp(join(tmpdir(), 'dsh-voice-preparation-'))
  const resources: { scaffold?: WebScaffold; browser?: Browser } = {}
  onTestFinished(async () => {
    try { await resources.browser?.close() } finally {
      try { await resources.scaffold?.close() } finally { await rm(scratch, { recursive: true, force: true }) }
    }
  })
  const overlay = join(scratch, 'voice.patch.yml')
  await writeFile(overlay, '- id: speech-to-text-sensevoice\n  disabled: true\n')
  const scaffold = await launchWebScaffold({ extraInstallAnchors: [join(bundle, 'package.json')],
    extraOverlayPath: [join(bundle, 'cordis.patch.yml'), overlay] })
  resources.scaffold = scaffold
  let preparation: SpeechPreparationState = { phase: 'unprepared' }
  const listeners = new Set<() => void>()
  await scaffold.ctx.plugin({ inject: ['speechToText'], apply(ctx) {
    ctx.effect(() => ctx.speechToText.register({
      info: { id: 'sensevoice-local' as SpeechProviderId, name: 'Review recognizer', location: 'host-local', languages: ['auto', 'en', 'zh'],
        setupEstimate: { recommendedDiskBytes: 1_000_000_000, expectedMemoryBytes: 500_000_000, minimumMinutes: 1, maximumMinutes: 3 },
        downloadSources: ['https://huggingface.co', 'https://hf-mirror.com'] },
      preparation: {
        snapshot: () => preparation,
        subscribe: (listener) => { listeners.add(listener); return () => { listeners.delete(listener) } },
        prepare: () => { throw new Error('This UI fixture never downloads model resources') }, cancel: async () => {},
      },
      transcribe: async () => { throw new Error('Preparation inspection does not record audio') },
    }))
  } })
  const browser = await responsiveBrowser.launch()
  resources.browser = browser
  const page = await newWorkflowPage(browser), tripwire = watchConsole(page)
  await page.goto(scaffold.authenticatedUrl, { waitUntil: 'domcontentloaded' })
  await connectFreshWorkspace(page, scaffold.workspaceCwd)
  await page.getByRole('button', { name: 'Plugins', exact: true }).click()
  await page.locator('[data-plugin-item="speech-to-text"]').getByRole('button', { name: 'View Voice', exact: true }).click()
  const detail = page.locator('[data-plugin-item-detail="speech-to-text"]')
  await detail.getByText('Review recognizer', { exact: true }).last().waitFor()
  const states: readonly SpeechPreparationState[] = [
    { phase: 'unprepared' },
    { phase: 'checking', step: 'check', startedAt: Date.now() },
    { phase: 'downloading', resource: 'speech-model.bin', completedBytes: 12_000_000, totalBytes: 48_000_000, step: 'model', steps: [
      { kind: 'check', status: 'complete' }, { kind: 'model', status: 'running' }, { kind: 'vad', status: 'pending' },
      { kind: 'verify', status: 'pending' }, { kind: 'load', status: 'pending' },
    ] },
    { phase: 'loading', step: 'load', startedAt: Date.now() },
    { phase: 'waking', startedAt: Date.now() },
    { phase: 'cancelling', startedAt: Date.now() },
    { phase: 'cancelled' },
    { phase: 'failed', message: 'Unable to prepare the selected speech model.', download: {
      resource: 'speech-model.bin', source: 'https://huggingface.co', reason: 'network', code: 'ECONNRESET',
    } },
    { phase: 'standby' },
    { phase: 'ready' },
  ]
  const summaries: Readonly<Record<SpeechPreparationState['phase'], string>> = {
    unprepared: 'First use downloads the local recognition models.', checking: 'Checking local resources…',
    downloading: 'Prepare recognition model', loading: 'Loading Review recognizer…', waking: 'Waking local speech recognition…',
    cancelling: 'Cancelling preparation…', cancelled: 'Preparation cancelled. Completed downloads are retained.',
    failed: 'Setup failed', standby: 'Local resources are prepared. Recording wakes the recognizer.', ready: 'Local speech recognition is ready.',
  }
  for (const state of states) {
    preparation = state
    for (const listener of listeners) listener()
    const summary = detail.getByText(summaries[state.phase], { exact: true })
    await summary.waitFor()
    await auditWorkflowState(page, 'voice-preparation', state.phase, detail)
    if (state.phase === 'downloading') {
      await summary.click()
      await detail.getByRole('listitem', { name: 'Prepare recognition model · In progress', exact: true }).waitFor()
      await auditWorkflowState(page, 'voice-preparation', 'download-steps', detail)
      await detail.getByText('Preparation steps', { exact: true }).click()
    }
  }
  expect(tripwire.pageErrors).toEqual([])
}, workflowMatrixEnabled ? 300_000 : 90_000)
