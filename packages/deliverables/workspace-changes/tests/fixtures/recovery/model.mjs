/** One failed execution-world Git probe followed by real native Git and SDK model turns. */
import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { LlmAdapter } from '@deepseek-ai/dsh-llm'
export const name = 'review-recovery-fixture'
export const inject = ['llm', 'fs', 'subprocess']
export async function apply(ctx) {
  let probes = 0, modelRequests = 0
  const directory = join(process.cwd(), '.fixture-state')
  await mkdir(directory)
  const publish = () => writeFile(join(directory, 'observations.json'), JSON.stringify({ probes, modelRequests }))
  await publish()
  const fs = ctx.fs, subprocess = ctx.subprocess
  const spawn = subprocess.spawn
  const hostDescriptor = Object.getOwnPropertyDescriptor(fs, 'processPathFromHostPath')
  const spawnDescriptor = Object.getOwnPropertyDescriptor(subprocess, 'spawn')
  const executionWorld = () => undefined
  const controlledSpawn = async function (spec) {
    if (spec.argv[0] === '/bin/sh' && spec.argv[4] === 'workspace-snapshot'
      && spec.argv[3].includes('/usr/bin/xcode-select -p')) {
      probes++
      await publish()
      if (probes === 1) throw new Error('Fixture Git probe admission is unavailable')
    }
    return spawn.call(this, spec)
  }
  ctx.effect(() => {
    Object.defineProperty(fs, 'processPathFromHostPath', { value: executionWorld, configurable: true, writable: true })
    Object.defineProperty(subprocess, 'spawn', { value: controlledSpawn, configurable: true, writable: true })
    return async () => {
      if (Object.getOwnPropertyDescriptor(fs, 'processPathFromHostPath')?.value === executionWorld) {
        if (hostDescriptor === undefined) Reflect.deleteProperty(fs, 'processPathFromHostPath')
        else Object.defineProperty(fs, 'processPathFromHostPath', hostDescriptor)
      }
      if (Object.getOwnPropertyDescriptor(subprocess, 'spawn')?.value === controlledSpawn) {
        if (spawnDescriptor === undefined) Reflect.deleteProperty(subprocess, 'spawn')
        else Object.defineProperty(subprocess, 'spawn', spawnDescriptor)
      }
      await writeFile(join(directory, 'cleanup.json'), JSON.stringify({
        hostMappingRestored: Object.getOwnPropertyDescriptor(fs, 'processPathFromHostPath')?.value === hostDescriptor?.value,
        spawnRestored: Object.getOwnPropertyDescriptor(subprocess, 'spawn')?.value === spawnDescriptor?.value,
      }))
    }
  })
  class Adapter extends LlmAdapter {
    async resolveModel(provider, model) { return { provider, id: model, name: model } }
    async *stream() {
      modelRequests++
      await publish()
      assert.equal(probes, 2, 'Model execution requires a successful second Git probe')
      const text = 'REVIEW_RECOVERED'
      yield { type: 'block-start', index: 0, blockType: 'text' }
      yield { type: 'text-delta', index: 0, text }
      yield { type: 'block-end', index: 0, block: { type: 'text', text } }
      yield { type: 'finish', reason: { kind: 'stop' } }
    }
  }
  ctx.effect(() => ctx.llm.registerAdapter(['review-recovery'], new Adapter()))
  ctx.provide('workspaceReviewRecoveryReady', true)
}
