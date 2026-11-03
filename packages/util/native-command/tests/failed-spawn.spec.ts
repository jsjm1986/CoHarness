/** Failed native allocation and cancellation cannot signal the caller's process group. */
import { spawn } from 'node:child_process'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, it } from 'vitest'

it('preserves the caller through pre-dispatch cancellation, failed allocation cancellation and an uncancelled missing executable', async ({ task }) => {
  const implementation = process.env.DSH_NATIVE_CANCEL_ARTIFACT === '1' ? 'lib' : 'src'
  const lines: string[] = []
  for (const mode of ['before-existing', 'before-missing', 'during-missing', 'missing-active', 'during-live']) {
    const result = await new Promise<string>((resolve, reject) => {
      const child = spawn(process.execPath, [
        ...implementation === 'src' ? ['--import', import.meta.resolve('tsx/esm')] : [],
        fileURLToPath(new URL('./fixtures/failed-spawn-cancellation.mjs', import.meta.url)), mode, implementation,
      ], {
        detached: true, timeout: task.timeout, killSignal: 'SIGKILL', stdio: ['ignore', 'pipe', 'pipe'],
      })
      let stdout = '', stderr = ''
      child.stdout.on('data', (chunk) => { stdout += String(chunk) })
      child.stderr.on('data', (chunk) => { stderr += String(chunk) })
      child.once('error', reject)
      child.once('close', (code, signal) => {
        if (code === 0 && signal === null) resolve(stdout)
        else reject(new Error(`Native fixture exited ${String(code)}/${String(signal)}: ${stderr}`))
      })
    })
    lines.push(result.trim())
  }
  await expect(lines.join('\n')+'\n').toMatchFileSnapshot(join(import.meta.dirname, 'expected/failed-spawn-cancellation.jsonl'))
})
