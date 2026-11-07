/** The caller survives cancellation overlapping a failed native control/maintenance allocation. */
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { expect, it } from 'vitest'

it('retains the Gateway caller when control and maintenance executables fail to allocate', async ({ task }) => {
  const implementation = process.env.HGW_CANCEL_ARTIFACT === '1' ? 'lib' : 'src', lines: string[] = []
  for (const mode of ['helper-pre', 'helper-post', 'maintenance-post', 'maintenance-active']) {
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
