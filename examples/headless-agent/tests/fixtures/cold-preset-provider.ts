/** Host service whose initialization is released only after a preset waits. */
import type { Context } from '@deepseek-ai/cordis'
import type {} from './cold-preset-model.ts'

export const name = 'cold-preset-provider'
export const inject = ['coldPresetControl']
/** Publish the service after the fixture barrier. @param ctx - Host context. */
export async function apply(ctx: Context): Promise<void> {
  ctx.coldPresetControl.entered.resolve(undefined)
  await ctx.coldPresetControl.release.promise
  ctx.provide('coldPresetReady', { value: 'ready' })
}
