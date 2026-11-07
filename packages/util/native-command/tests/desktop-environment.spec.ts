/** OS session evidence is observational and never implies desktop permissions or VNC reachability. */
import { expect, it, vi } from 'vitest'
import { inspectDesktopEnvironment, type DesktopEnvironmentInternals } from '../src/desktop-environment.ts'

function fixture(platform: NodeJS.Platform = 'linux', env: Record<string, string> = {}) {
  const entries = new Map<string, readonly string[]>(), contents = new Map<string, string>()
  const sockets = new Set<string>()
  const missing = () => Object.assign(new Error('missing OS observation'), { code: 'ENOENT' })
  const files = {
    readdir: vi.fn(async (path: string): Promise<readonly string[]> => {
      const value = entries.get(path)
      if (value === undefined) throw missing()
      return value
    }),
    readFile: vi.fn(async (path: string, _encoding: 'utf8') => { const value = contents.get(path); if (value === undefined) throw missing(); return value }),
    stat: vi.fn(async (path: string): Promise<{ uid: number; isSocket(): boolean }> => {
      if (!sockets.has(path)) throw missing()
      return { uid: 0, isSocket: () => true }
    }),
  } satisfies NonNullable<DesktopEnvironmentInternals['files']>
  return { entries, contents, sockets, files, inspect: () => inspectDesktopEnvironment({ platform, env, files }) }
}

it('does not infer a graphical desktop from a tty login or a graphical boot target', async () => {
  const f = fixture()
  f.entries.set('/run/systemd/sessions', ['21', '21.ref', '../escape'])
  f.contents.set('/run/systemd/sessions/21', 'ACTIVE=1\nSTATE=active\nTYPE=tty\nIS_DISPLAY=0\n')
  expect(await f.inspect()).toEqual({ state: 'not-detected', reason: 'no-graphical-session' })
  expect(f.files.readFile).toHaveBeenCalledTimes(1)
})

it.each(['DISPLAY', 'WAYLAND_DISPLAY'])('recognizes an announced %s without probing permissions', async (key) => {
  const f = fixture('linux', { [key]: key === 'DISPLAY' ? ':1' : 'wayland-0' })
  expect(await f.inspect()).toEqual({ state: 'detected', reason: 'display-environment' })
  expect(f.files.readdir).not.toHaveBeenCalled()
  expect(f.files.stat).not.toHaveBeenCalled()
})

it.each(['x11', 'wayland'])('recognizes a %s session and ignores a closing graphical session', async (type) => {
  const f = fixture()
  f.entries.set('/run/systemd/sessions', ['21'])
  f.contents.set('/run/systemd/sessions/21', `TYPE=${type}\nSTATE=active\n`)
  expect(await f.inspect()).toEqual({ state: 'detected', reason: 'graphical-session' })
  f.contents.set('/run/systemd/sessions/21', `TYPE=${type}\nSTATE=closing\n`)
  expect((await f.inspect()).state).toBe('not-detected')
})

it('recognizes a virtual X display without a login session and tolerates disappearing observations', async () => {
  const f = fixture()
  f.entries.set('/run/systemd/sessions', ['vanished'])
  f.entries.set('/tmp/.X11-unix', ['X0', 'unrelated', 'X2'])
  f.sockets.add('/tmp/.X11-unix/X2')
  expect(await f.inspect()).toEqual({ state: 'detected', reason: 'display-socket' })
})

it.each(['EACCES', 'EPERM', 'EIO'])('keeps %s observations unknown rather than disabling a possible desktop', async (code) => {
  const f = fixture()
  f.files.readdir.mockRejectedValue(Object.assign(new Error('cannot observe sessions'), { code }))
  expect(await f.inspect()).toEqual({ state: 'unknown', reason: 'inspection-unavailable' })
})

it('reports a macOS console user separately from operating-system permissions', async () => {
  const f = fixture('darwin')
  f.files.stat.mockResolvedValue({ uid: 501, isSocket: () => false })
  expect(await f.inspect()).toEqual({ state: 'detected', reason: 'console-user' })
  f.files.stat.mockResolvedValue({ uid: 0, isSocket: () => false })
  expect(await f.inspect()).toEqual({ state: 'not-detected', reason: 'no-graphical-session' })
})

it('leaves an unverified platform unknown and does not swallow programming failures', async () => {
  const f = fixture('win32')
  expect(await f.inspect()).toEqual({ state: 'unknown', reason: 'platform-unverified' })
  expect(f.files.stat).not.toHaveBeenCalled()
  const broken = fixture()
  broken.files.readdir.mockRejectedValue(new TypeError('invalid inspection implementation'))
  await expect(broken.inspect()).rejects.toThrow('invalid inspection implementation')
})
