/** Exercise command ownership and durable refusal through the actual SDK application. */
import assert from 'node:assert/strict'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { LlmAdapter } from '@deepseek-ai/dsh-llm'
export const inject = ['llm', 'agents']
export async function apply(ctx) {
  const face = process.env.DSH_EXAMPLE_MODE === 'src' ? 'src/index.ts' : 'lib/index.js'
  const entry = process.env.DSH_COMMANDS_ENTRY
    ?? new URL(`../../../../../packages/interaction/commands/${face}`, import.meta.url).href
  const { CommandRuntime } = await import(entry)
  await ctx.plugin(CommandRuntime)
  const commands = ctx.get('commands'); assert.ok(commands)
  let exercised = false
  class Adapter extends LlmAdapter {
    async resolveModel(provider, model) { return { provider, id: model, name: model, context: { contextWindow: 100000 }, defaultMaxTokens: 512 } }
    async *stream(options, dispatchRequest) {
      await dispatchRequest(async () => {})
      let passed = true
      if (!exercised && options.purpose !== 'session-title') {
        exercised = true
        const agent = ctx.agents.get(options.sessionId); assert.ok(agent)
        const signal = options.signal ?? new AbortController().signal
        let originalRuns = 0, replacementRuns = 0, cancelledRuns = 0, acceptedRuns = 0
        const outcomes = []
        for (const mode of ['removed', 'replaced']) {
          const name = `owner-${mode}`
          let unregister = commands.register({ name, description: 'Fixture command owner', handler: () => {
            originalRuns++
            return { kind: 'success' }
          } })
          const stop = ctx.on('session/event', (session, event) => {
            if (session !== agent.session || event.type !== 'command/run' || event.data.name !== name) return
            unregister()
            if (mode === 'replaced') unregister = commands.register({ name, description: 'Replacement command owner', handler: () => {
              replacementRuns++
              return { kind: 'success' }
            } })
          }, { global: true })
          try {
            const execution = await commands.execute(agent, `/${name}`, [], signal)
            outcomes.push({ mode, result: execution.result })
          } finally { stop(); unregister() }
        }
        const cancellation = new AbortController()
        const cancelReason = new Error('fixture cancelled before handler entry')
        const removeCancelled = commands.register({ name: 'owner-cancelled', description: 'Cancelled fixture command', handler: () => {
          cancelledRuns++
          return { kind: 'success' }
        } })
        const stopCancellation = ctx.on('session/event', (session, event) => {
          if (session === agent.session && event.type === 'command/run' && event.data.name === 'owner-cancelled') {
            cancellation.abort(cancelReason)
          }
        }, { global: true })
        try {
          await commands.execute(agent, '/owner-cancelled', [], cancellation.signal)
          outcomes.push({ mode: 'cancelled', result: { kind: 'unexpected-success' } })
        } catch (error) {
          assert.equal(error, cancelReason)
          outcomes.push({ mode: 'cancelled', result: { kind: 'aborted', text: error.message } })
        } finally { stopCancellation(); removeCancelled() }
        const unregister = commands.register({ name: 'owner-accepted', description: 'Available fixture command', handler: () => {
          acceptedRuns++
          return { kind: 'success', text: 'AVAILABLE_COMMAND_OK' }
        } })
        try {
          const execution = await commands.execute(agent, '/owner-accepted', [], signal)
          outcomes.push({ mode: 'accepted', result: execution.result })
        } finally { unregister() }
        const lifecycle = agent.session.snapshotEvents()
          .filter(event => event.type === 'command/run' || event.type === 'command/done')
          .map(event => event.type === 'command/run'
            ? { type: event.type, name: event.data.name }
            : { type: event.type, kind: event.data.kind })
        const proof = { originalRuns, replacementRuns, cancelledRuns, acceptedRuns, outcomes, lifecycle }
        await writeFile(join(process.cwd(), 'command-registration-proof.json'), JSON.stringify(proof))
        passed = originalRuns === 0 && replacementRuns === 0 && cancelledRuns === 0 && acceptedRuns === 1
          && outcomes.slice(0, 2).every(outcome => outcome.result.kind === 'error')
      }
      yield { type: 'block-end', index: 0, block: { type: 'text', text: passed ? 'COMMAND_REGISTRATION_OK' : 'COMMAND_REGISTRATION_FAILED' } }
      yield { type: 'finish', reason: { kind: 'stop' } }
    }
  }
  ctx.effect(() => ctx.llm.registerAdapter(['command-registration-fixture'], new Adapter()))
  ctx.provide('commandRegistrationReady', true)
}
