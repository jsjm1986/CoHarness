/** Package-hook retirement is isolated from Vitest's own module loader. */
import { spawn } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, it, onTestFinished } from 'vitest'

it.each(['inner-first', 'outer-first', 'reuse-inner'])(
  'restores the original Node methods after overlapping manifest owners retire (%s)', async (order) => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-package-hook-lifetime-'))
    const child = spawn(process.execPath, ['--expose-internals', '--import', 'tsx/esm',
      fileURLToPath(new URL('./fixtures/package-hook-lifetime.mjs', import.meta.url)), root, order],
    { stdio: ['ignore', 'pipe', 'pipe'] })
    const done = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
      child.once('error', reject)
      child.once('close', (code, signal) => { resolve({ code, signal }) })
    })
    onTestFinished(async () => {
      try {
        if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
        await done
      } finally { await rm(root, { recursive: true, force: true }) }
    })
    let stdout = '', stderr = ''
    child.stdout.setEncoding('utf8').on('data', (chunk: string) => { stdout += chunk })
    child.stderr.setEncoding('utf8').on('data', (chunk: string) => { stderr += chunk })
    const result = await done
    expect(result.signal, stderr).toBeNull()
    expect(result.code, stderr).toBe(0)
    expect(stdout).toBe('first owner retired\nall hooks restored\n')
  },
)
