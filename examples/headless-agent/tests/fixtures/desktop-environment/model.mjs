/** Real SDK startup and model request with desktop environment facts but no desktop driver. */
import assert from 'node:assert/strict'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { LlmAdapter } from '@deepseek-ai/dsh-llm'

export const inject = ['llm', 'computerUseEnvironment']

/** Observe the normal prompt and durable system message at the deterministic model transport. */
export function apply(ctx) {
  const reason = ctx.computerUseEnvironment.unavailableReason
  assert.ok(['headless', 'disabled'].includes(reason))
  let logged
  ctx.on('session/event', (_session, event) => {
    if (event.type === 'system/message') logged = event.data.message
  })
  class Adapter extends LlmAdapter {
    async resolveModel(provider, model) { return { provider, id: model, name: model, defaultMaxTokens: 128 } }
    async *stream(options, dispatchRequest) {
      const system = options.messages.find(message => message.role === 'system')
      assert.ok(system)
      assert.deepEqual(system.content, logged?.content, 'Model-visible environment guidance must be reconstructable from the Session')
      const prompt = system.content.filter(block => block.type === 'text').map(block => block.text).join('\n')
      const guidance = reason === 'headless' ? 'This server has no detected graphical desktop.' : 'No computer-use desktop driver is enabled in this runtime.'
      assert.ok(prompt.includes(guidance), prompt)
      assert.ok(prompt.includes('File, terminal and separately configured headless-browser tools remain independent.'))
      assert.equal(ctx.get('computerUse'), undefined)
      assert.equal(ctx.get('computerUseAuthorization'), undefined)
      await dispatchRequest(async () => {})
      await writeFile(join(process.cwd(), 'desktop-environment-observation.json'), JSON.stringify({
        reason, guidance, logged: true, driverRegistered: false, authorityPublished: false,
        tools: (options.tools ?? []).map(tool => tool.name).filter(name => /computer|desktop|screenshot/.test(name)),
      }))
      const text = 'DESKTOP_ENVIRONMENT_EXPLAINED'
      yield { type: 'block-start', index: 0, blockType: 'text' }
      yield { type: 'text-delta', index: 0, text }
      yield { type: 'block-end', index: 0, block: { type: 'text', text } }
      yield { type: 'usage', usage: { inputTokens: 10, outputTokens: 4 } }
      yield { type: 'finish', reason: { kind: 'stop' } }
    }
  }
  ctx.effect(() => ctx.llm.registerAdapter(['desktop-environment-fixture'], new Adapter()))
  ctx.provide('desktopAvailabilityFixtureReady', true)
}
