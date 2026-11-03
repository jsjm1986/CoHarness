/** An already cancelled host operation never reaches native process creation. */
import { EventEmitter } from 'node:events'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { runNativeCommand } from '../src/runner.ts'

const native = vi.hoisted(() => ({ execute: vi.fn() }))
vi.mock('node:child_process', () => {
  return { execFile: native.execute }
})
beforeEach(() => { native.execute.mockImplementation(() => { throw new Error('Unexpected native process creation') }) })
afterEach(() => { native.execute.mockClear() })

it.each([process.execPath, 'dsh-already-cancelled-executable-missing'])('refuses a cancelled %s invocation before native dispatch', async (command) => {
  const controller = new AbortController(), reason = new Error('caller closed before dispatch')
  controller.abort(reason)
  const failure = await runNativeCommand(command, ['-e', 'process.stdout.write("unexpected execution")'], controller.signal, 'hidden')
    .then(() => { throw new Error('cancelled command resolved') }, (error: unknown) => error)
  expect(failure).toMatchObject({ code: 'ABORT_ERR', stdout: '', stderr: '' })
  expect(native.execute).not.toHaveBeenCalled()
})

it('does not signal an unallocated native handle when cancellation overlaps failed spawn delivery', async () => {
  const child = Object.assign(new EventEmitter(), { pid: undefined, kill: vi.fn() })
  native.execute.mockImplementation((_command: string, _args: readonly string[], _options: unknown,
    callback: (error: Error & { code: string }, stdout: string, stderr: string) => void) => {
    queueMicrotask(() => {
      callback(Object.assign(new Error('missing executable'), { code: 'ENOENT' }), '', '')
      child.emit('close', -2)
    })
    return child
  })
  const controller = new AbortController()
  const pending = runNativeCommand('missing executable', [], controller.signal, 'hidden')
  controller.abort(new Error('caller left during allocation'))
  await expect(pending).rejects.toMatchObject({ code: 'ABORT_ERR', stdout: '', stderr: '' })
  expect(child.kill).not.toHaveBeenCalled()
  expect(native.execute.mock.calls[0]![2]).not.toHaveProperty('signal')
})
