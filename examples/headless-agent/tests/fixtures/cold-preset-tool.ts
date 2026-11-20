/** Preset contribution requiring the asynchronous Host service. */
import type { Context } from '@deepseek-ai/cordis'
import { defineContentToolFixture } from '@deepseek-ai/dsh-tools'
import type {} from './cold-preset-model.ts'

export const name = 'cold-preset-tool'
export const inject = ['tools', 'coldPresetReady']
/** Register a tool only after its Host service resolves. @param ctx - Preset context. */
export function apply(ctx: Context): void {
  ctx.effect(() => ctx.tools.register(defineContentToolFixture({
    name: 'cold_ready', description: 'Inspect the initialized Host service', parameters: {},
    execute: async () => [{ type: 'text', text: ctx.coldPresetReady.value }],
  })))
}
