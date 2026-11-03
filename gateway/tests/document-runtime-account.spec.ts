/** External account records determine publication ownership only after both queries close. */
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { documentRuntimeAccess } from '../src/document-storage.ts'

const io = vi.hoisted(() => ({ command: vi.fn(), chown: vi.fn(), chmod: vi.fn(), lstat: vi.fn() }))
vi.mock('../src/child-command.ts', () => ({ runGatewayChildCommand: io.command }))
vi.mock('node:fs/promises', async original => ({
  ...await original<typeof import('node:fs/promises')>(), chown: io.chown, chmod: io.chmod, lstat: io.lstat,
}))
const platform = Object.getOwnPropertyDescriptor(process, 'platform')!

beforeEach(() => {
  Object.defineProperty(process, 'platform', { ...platform, value: 'linux' })
  vi.spyOn(process, 'getuid').mockReturnValue(0)
  io.command.mockImplementation(async (_command: string, args: string[]) => ({ stdout: args[0] === '-u' ? '123\n' : '456\n', stderr: '' }))
  io.chown.mockResolvedValue(undefined); io.chmod.mockResolvedValue(undefined)
  io.lstat.mockResolvedValue({ isFile: () => true, isSymbolicLink: () => false })
})
afterEach(() => {
  Object.defineProperty(process, 'platform', platform)
  vi.restoreAllMocks(); vi.resetAllMocks()
})

it.each([false, true])('publishes with the selected account and shared-project setting %s', async shared => {
  const access = await documentRuntimeAccess('runtime-account', shared, 321)
  await access.prepareDirectory!('/fixture/documents')
  await access.preparePublished!('/fixture/published')
  expect(io.chown.mock.calls).toEqual([['/fixture/documents', shared ? 0 : 123, 456], ['/fixture/published', shared ? 0 : 123, 456]])
  expect(io.chmod.mock.calls).toEqual([['/fixture/documents', shared ? 0o2770 : 0o700], ['/fixture/published', shared ? 0o660 : 0o600]])
})

it.each(['darwin', 'unprivileged'] as const)('leaves development filesystem ownership to the %s host', async host => {
  if (host === 'darwin') Object.defineProperty(process, 'platform', { ...platform, value: 'darwin' })
  else vi.mocked(process.getuid!).mockReturnValue(123)
  expect(await documentRuntimeAccess('runtime-account', false, 321)).toEqual({})
  expect(io.command).not.toHaveBeenCalled()
})

it('refuses an already cancelled lookup without starting a child', async () => {
  const reason = new Error('caller left')
  await expect(documentRuntimeAccess('runtime-account', false, 321, AbortSignal.abort(reason))).rejects.toBe(reason)
  expect(io.command).not.toHaveBeenCalled()
})

it.each(['-u', '-g'])('retains the other helper after the %s lookup fails', async failing => {
  let finish!: (value: { stdout: string; stderr: string }) => void
  const remaining = new Promise<{ stdout: string; stderr: string }>(resolve => { finish = resolve }), failure = new Error('native lookup failed')
  io.command.mockImplementation((_command: string, args: string[]) => args[0] === failing ? Promise.reject(failure) : remaining)
  const lookup = documentRuntimeAccess('runtime-account', false, 321)
  const observed = vi.fn()
  void lookup.then(observed, observed)
  await Promise.resolve()
  expect(observed).not.toHaveBeenCalled()
  finish({ stdout: '123', stderr: '' })
  await expect(lookup).rejects.toBe(failure)
  expect(io.chown).not.toHaveBeenCalled()
})

it('preserves cancellation after both native queries finish without publishing access callbacks', async () => {
  const controller = new AbortController(), reason = new Error('cancelled during lookup')
  io.command.mockImplementation(async () => { controller.abort(reason); return { stdout: '123', stderr: '' } })
  await expect(documentRuntimeAccess('runtime-account', true, 321, controller.signal)).rejects.toBe(reason)
  expect(io.command).toHaveBeenCalledTimes(2)
})

it.each(['', '0', '-1', '1e3', '0x123', '1.5', '4294967296', '9007199254740992'])('rejects invalid external account identity %j', async text => {
  for (const flag of ['-u', '-g']) {
    io.command.mockImplementation(async (_command: string, args: string[]) => ({ stdout: args[0] === flag ? text : '123', stderr: '' }))
    await expect(documentRuntimeAccess('runtime-account', true, 321)).rejects.toThrow('account runtime-account is invalid')
  }
  expect(io.chown).not.toHaveBeenCalled()
})

it.each([{ file: false, link: false }, { file: true, link: true }])('refuses publication ownership changes on invalid file $file/link $link', async ({ file, link }) => {
  const access = await documentRuntimeAccess('runtime-account', true, 321)
  io.lstat.mockResolvedValue({ isFile: () => file, isSymbolicLink: () => link })
  await expect(access.preparePublished!('/fixture/changed')).rejects.toThrow('regular file')
  expect(io.chown).not.toHaveBeenCalled()
})
