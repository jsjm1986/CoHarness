/** Native allocation probes, exact-generation signalling and whole-slice stop evidence. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { localLinuxRuntimeCommand, localLinuxRuntimeEmpty, localRuntimeSlice, probeLocalLinuxScope, stopLocalLinuxRuntime } from '../src/local-runtime-linux.ts'
import type { LocalRuntimeOwnerNonce, LocalRuntimeOwnerRecord } from '../src/local-runtime-owner.ts'

const command = vi.hoisted(() => vi.fn())
vi.mock('../src/child-command.ts', () => ({ runGatewayChildCommand: command }))
const platform = Object.getOwnPropertyDescriptor(process, 'platform')!
beforeEach(() => { Object.defineProperty(process, 'platform', { ...platform, value: 'linux' }) })
afterEach(() => { Object.defineProperty(process, 'platform', platform); command.mockReset() })
const record: LocalRuntimeOwnerRecord = {
  version: 1, nativeRange: 'linux-slice', nonce: '01234567-89ab-4def-8123-0123456789ab' as LocalRuntimeOwnerNonce,
  token: 'a'.repeat(43), bootId: '01234567-89ab-4def-8123-0123456789ab', phase: 'reserved',
  lock: { device: '1', inode: '2' },
  identity: { node: 'node', kind: 'user', ownerId: 1, runtimeKey: 'user-1', generation: 2, credentialHash: 'a'.repeat(64) },
}
const slice = 'dshruntime0123456789ab4def81230123456789ab.slice'
function state(tasks: string, active = 'active', load = 'loaded') {
  return { stdout: `LoadState=${load}\nActiveState=${active}\nTasksCurrent=${tasks}\n`, stderr: '' }
}

describe('local native Runtime ownership', () => {
  it('selects native containment only after a real literal-argv scope succeeds', async () => {
    command.mockResolvedValue({ stdout: '', stderr: '' })
    expect(await probeLocalLinuxScope(1000)).toBe('literal-option')
    expect(command).toHaveBeenCalledWith('systemd-run', expect.arrayContaining(['--scope', '--expand-environment=no', '--', '/bin/true']), 1000, undefined)
  })

  it('uses the literal scope argv behavior of older systemd versions only after their own successful probe', async () => {
    command.mockRejectedValueOnce({ stderr: "systemd-run: unrecognized option '--expand-environment=no'" }).mockResolvedValueOnce({ stdout: '', stderr: '' })
    expect(await probeLocalLinuxScope(1000)).toBe('literal-default')
    expect(command.mock.calls[1]?.[1]).not.toContain('--expand-environment=no')
  })

  it.each(['old-manager-unavailable', 'manager-unavailable', 'executable-missing'])('retains process-group mode after %s', async kind => {
    if (kind === 'old-manager-unavailable') command.mockRejectedValueOnce({ stderr: "unrecognized option '--expand-environment=no'" })
    command.mockRejectedValue(new Error(kind))
    expect(await probeLocalLinuxScope(1000)).toBeUndefined()
  })

  it('does not launch a native probe on macOS', async () => {
    Object.defineProperty(process, 'platform', { ...platform, value: 'darwin' })
    expect(await probeLocalLinuxScope(1000)).toBeUndefined()
    expect(command).not.toHaveBeenCalled()
  })

  it('refuses an already cancelled probe without running a helper', async () => {
    const signal = AbortSignal.abort(new Error('cancelled before probe'))
    await expect(probeLocalLinuxScope(1000, signal)).rejects.toThrow('cancelled before probe')
    expect(command).not.toHaveBeenCalled()
  })

  it.each([false, true])('propagates cancellation during the actual scope probe, including legacy retry: %s', async legacy => {
    const controller = new AbortController(), reason = new Error('cancelled during probe')
    if (legacy) command.mockRejectedValueOnce({ stderr: "unrecognized option '--expand-environment=no'" })
    command.mockImplementationOnce(() => { controller.abort(reason); return Promise.reject(new Error('native child cancelled')) })
    await expect(probeLocalLinuxScope(1000, controller.signal)).rejects.toBe(reason)
    expect(command).toHaveBeenLastCalledWith('systemd-run', expect.any(Array), 1000, controller.signal)
  })

  it('derives a PID-independent slice and preserves every literal Runtime argument', () => {
    expect(localRuntimeSlice(record)).toBe(slice)
    const target = ['/bin/tool', '$HOME', 'a b', '']
    for (const mode of ['literal-option', 'literal-default'] as const) {
      const argv = localLinuxRuntimeCommand(record, mode, target)
      expect(argv).toContain(`--slice=${slice}`)
      expect(argv).toContain(`--unit=${slice.replace('.slice', '.scope')}`)
      expect(argv.includes('--expand-environment=no')).toBe(mode === 'literal-option')
      expect(argv.slice(argv.indexOf('--') + 1)).toEqual(target)
    }
  })

  it.each([
    ['1', 'active', 'loaded', false], ['0', 'active', 'loaded', true],
    ['[not set]', 'inactive', 'loaded', true], ['[not set]', 'inactive', 'not-found', true],
    ['[not set]', 'active', 'loaded', false], ['3', 'inactive', 'loaded', false],
  ])('observes the whole descendant slice: tasks=%s, state=%s, load=%s', async (tasks, active, load, empty) => {
    command.mockResolvedValue(state(String(tasks), String(active), String(load)))
    expect(await localLinuxRuntimeEmpty(record, 500)).toBe(empty)
    expect(command).toHaveBeenCalledWith('systemctl', expect.arrayContaining([slice, '--property=TasksCurrent']), 500)
  })

  it.each([
    '', 'LoadState=loaded\nActiveState=active\n',
    'LoadState=loaded\nLoadState=loaded\nActiveState=active\nTasksCurrent=0\n',
    'LoadState=unknown\nActiveState=inactive\nTasksCurrent=0\n',
    'LoadState=loaded\nActiveState=unknown\nTasksCurrent=0\n',
    'LoadState=loaded\nActiveState=inactive\nTasksCurrent=-1\n',
    'LoadState=loaded\nActiveState=inactive\nTasksCurrent=0\nUnexpected=1\n',
  ])('refuses incomplete or ambiguous systemd output %j', async stdout => {
    command.mockResolvedValue({ stdout, stderr: '' })
    await expect(localLinuxRuntimeEmpty(record, 500)).rejects.toThrow('Invalid local Runtime slice observation')
  })

  it('retains uncertainty when a native observation fails', async () => {
    const failure = new Error('manager unavailable'); command.mockRejectedValue(failure)
    await expect(localLinuxRuntimeEmpty(record, 500)).rejects.toBe(failure)
  })

  it('joins slice retirement and observes descendant absence after force termination', async () => {
    command.mockResolvedValueOnce(state('3')).mockResolvedValueOnce({ stdout: '', stderr: '' })
      .mockResolvedValueOnce({ stdout: '', stderr: '' }).mockResolvedValueOnce(state('[not set]', 'inactive'))
    await stopLocalLinuxRuntime(record, 500)
    expect(command.mock.calls.map(call => call[1][1])).toEqual(['show', 'kill', 'stop', 'show'])
    expect(command.mock.calls[1]?.[1]).toEqual(['--user', 'kill', '--kill-who=all', '--signal=SIGKILL', slice])
  })

  it('does not signal a generation whose complete slice is already empty', async () => {
    command.mockResolvedValue(state('[not set]', 'inactive'))
    await stopLocalLinuxRuntime(record, 500)
    expect(command.mock.calls.map(call => call[1][1])).toEqual(['show', 'stop', 'show'])
  })

  it.each([true, false])('accepts a failed kill only with an independent empty observation: %s', async empty => {
    const failure = new Error('unit changed during kill')
    command.mockResolvedValueOnce(state('2')).mockRejectedValueOnce(failure).mockResolvedValueOnce(state(empty ? '0' : '1'))
      .mockResolvedValue(state('[not set]', 'inactive'))
    if (empty) await stopLocalLinuxRuntime(record, 500)
    else await expect(stopLocalLinuxRuntime(record, 500)).rejects.toBe(failure)
  })

  it('rejects a successful stop command while descendant tasks remain', async () => {
    command.mockResolvedValueOnce(state('3')).mockResolvedValueOnce({ stdout: '', stderr: '' })
      .mockResolvedValueOnce({ stdout: '', stderr: '' }).mockResolvedValueOnce(state('1'))
    await expect(stopLocalLinuxRuntime(record, 500)).rejects.toThrow('descendant slice remains occupied')
  })
})
