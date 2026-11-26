/** Keyless first-create and durable model-turn transcript through the real Loader. */
import { boot, resolveConfigPath } from '@deepseek-ai/dsh-app-boot'
import { SessionId } from '@deepseek-ai/dsh-session'
import { runFixtureTurn } from '@deepseek-ai/dsh-loader-smoke'
import type {} from '@deepseek-ai/dsh-session-persistence'
import type {} from './cold-preset-model.ts'

const path = process.argv[2]
if (path === undefined) throw new Error('Cold preset fixture requires a configuration')
const ctx = await boot('cold-preset-snapshot', resolveConfigPath(path, undefined))
const loader = ctx.loader, settle = loader.await.bind(loader)
const control = ctx.coldPresetControl
try {
  await loader.create({ name: new URL('./cold-preset-provider.ts', import.meta.url).href })
  await control.entered.promise
  let waited = false
  loader.await = async () => {
    waited = true
    control.release.resolve(undefined)
    await settle()
  }
  const handle = await ctx.agents.create({
    sessionId: SessionId('cold-preset'), agentOptions: { provider: 'cold-preset-model', model: 'fixture' },
    setup: async (agentCtx) => { await ctx.agentPresets.mount(agentCtx) },
  })
  loader.await = settle
  if (!waited) throw new Error('First create did not await the pending Host provider')
  process.stdout.write('First create waited for its Host dependency.\n')
  const result = await runFixtureTurn(ctx, { task: 'Inspect the ready Host tool.' })
  const stored = await ctx.sessionPersistence.inspect(handle.agent.id)
  if (stored.events.filter(event => event.type === 'assistant/message').length !== 1) {
    throw new Error('First reply did not persist exactly once')
  }
  process.stdout.write(`${JSON.stringify(result)}\n`)
  process.stdout.write('One assistant reply persisted.\n')
  await handle.dispose()
} finally {
  loader.await = settle
  control.release.resolve(undefined)
  await settle()
  await ctx.fiber.dispose()
}
