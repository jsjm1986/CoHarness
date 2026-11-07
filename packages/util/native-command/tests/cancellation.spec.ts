/** Native-command cancellation owns the helper until its process has closed. @module */
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, onTestFinished } from 'vitest'
import { runNativeCommand } from '../src/runner.ts'

function running(pid: number): boolean {
  try { process.kill(pid, 0); return true } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false
    throw error
  }
}

it.skipIf(process.platform === 'win32')('reaps a POSIX helper that ignores SIGTERM before reporting cancellation', async ({ task }) => {
  const root = await mkdtemp(join(tmpdir(), 'native-command-cancel-'))
  const pidFile = join(root, 'pid'), ready = join(root, 'ready')
  const lifetime = new AbortController()
  let pid: number | undefined
  const pending = runNativeCommand(process.execPath, ['--input-type=module', '-e', `
    import { writeFileSync } from 'node:fs';
    writeFileSync(process.argv[1], String(process.pid));
    process.on('SIGTERM', () => {});
    writeFileSync(process.argv[2], 'ready');
    setInterval(() => {}, 60_000);
  `, pidFile, ready], lifetime.signal, 'hidden').then(() => undefined, (error: unknown) => error)
  onTestFinished(async () => {
    lifetime.abort()
    if (pid === undefined) {
      try { pid = Number(await readFile(pidFile, 'utf8')) } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      }
    }
    if (pid !== undefined && Number.isSafeInteger(pid) && pid > 0) {
      if (running(pid)) process.kill(pid, 'SIGKILL')
      await expect.poll(() => running(pid!), { timeout: task.timeout }).toBe(false)
    }
    await pending
    await rm(root, { recursive: true, force: true })
  })
  await expect.poll(async () => {
    pid = Number(await readFile(pidFile, 'utf8'))
    return readFile(ready, 'utf8')
  }, { timeout: task.timeout }).toBe('ready')
  lifetime.abort()
  expect(await pending).toMatchObject({ code: 'ABORT_ERR' })
  const helperRunningAfterReturn = running(pid!)
  expect(helperRunningAfterReturn).toBe(false)
  await expect(JSON.stringify({ code: 'ABORT_ERR', helperRunningAfterReturn }) + '\n')
    .toMatchFileSnapshot(join(import.meta.dirname, 'expected/cancellation.jsonl'))
})
