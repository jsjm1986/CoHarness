/** Source-safe lifecycle for the optional speech Remote and browser UI. */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-api-remotes/client'
import type {} from '@deepseek-ai/dsh-experimental-api-speech-to-text/remote'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {} from '@deepseek-ai/dsh-client-ui-plugin-manager/client'
import { requestSettingsSection } from '@deepseek-ai/dsh-client-runtime/client'
import type { TypertRemoteContribution } from '@deepseek-ai/dsh-typert-protocol'
import { VoiceInput, type VoiceInputInjected } from './VoiceInput.tsx'
import { VoicePluginsItem } from './PreparationCard.tsx'
import { Recording } from './audio.ts'
import { en, NS, zh } from './locales.ts'
import { observeReadiness } from './readiness.ts'

export const inject = ['remote', 'slots', 'locale']

function registerUi(ctx: Context): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }))
  const recordings = new Set<Recording>()
  const readiness = observeReadiness(ctx)
  ctx.effect(() => readiness.dispose)
  ctx.effect(() => async () => { await Promise.all([...recordings].map(recording => recording.dispose())) })
  const actions: VoiceInputInjected = {
    // The voice surface lives on the Plugins page; an experimental mount may
    // still run without the manager, in which case plain Settings is the
    // nearest surface the shell can open.
    openSettings: () => {
      const navigation = ctx.get('pluginNavigation')
      if (navigation === undefined) { requestSettingsSection(); return }
      navigation.openItem('speech-to-text')
    },
    hooks: { speechReadiness: readiness.state },
    createRecording: () => {
      const recording = new Recording(() => { recordings.delete(recording) })
      recordings.add(recording)
      return recording
    },
    transcribe: async (request, signal) => await ctx.remote.speech.transcribe(request, signal),
    configure: async (patch) => { const result = await ctx.remote.speech.configure(patch); if (!result.ok) throw result.error },
    prepare: async (providerId, options) => {
      const result = await ctx.remote.speech.prepare(providerId, options); if (!result.ok) throw result.error
    },
    cancelPreparation: async (providerId) => {
      const result = await ctx.remote.speech.cancelPreparation(providerId); if (!result.ok) throw result.error
    },
  }
  ctx.slots.inject('conversation.input.right', () => ctx.slots.register({
    name: 'conversation.input.right', id: 'voice-input', order: 0, locale: NS, inject: () => actions,
  }, VoiceInput))
  // The Plugins page's Configuration group keys an official item by its
  // host-plane settings namespace, which the speech plugin registers on first
  // use; the page then lists and opens this surface like every other card.
  ctx.slots.inject('plugins.item', () => ctx.slots.register({
    name: 'plugins.item', id: 'speech-to-text', order: 60,
    label: () => ctx.locale.bind(NS)('nav'), locale: NS, inject: () => actions,
  }, VoicePluginsItem))
}

/**
 * Mount this experimental namespace without adding it to stable API Remotes.
 * @param ctx - Client runtime owning the Remote, dictionaries and slots.
 * @param contribution - generated speech Remote definitions.
 * @returns disposer joining UI and Remote withdrawal.
 */
export async function mountVoiceInput(ctx: Context, contribution: TypertRemoteContribution): Promise<() => Promise<void>> {
  const disposeRemote = await ctx.remote.$mount(contribution)
  const ui = ctx.inject(['remote.speech', 'slots', 'locale'], registerUi)
  try { await ui } catch (error) { await ui.dispose(); await disposeRemote(); throw error }
  return async () => { await ui.dispose(); await disposeRemote() }
}
