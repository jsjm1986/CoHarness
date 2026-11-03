/** Read-only desktop-session observation; does not capture screens, request permissions or start a driver. */
import { readdir, readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'

/** Session detection is separate from desktop transport, OS permissions and application authorization. */
export interface DesktopEnvironment {
  readonly state: 'detected' | 'not-detected' | 'unknown'
  readonly reason: 'display-environment' | 'graphical-session' | 'display-socket' | 'console-user' | 'no-graphical-session' | 'inspection-unavailable' | 'platform-unverified'
}

/** Platform facts and read-only OS operations, replaceable for isolated observation tests. */
export interface DesktopEnvironmentInternals {
  readonly platform?: NodeJS.Platform
  readonly env?: Readonly<Record<string, string | undefined>>
  readonly files?: {
    readdir(path: string): Promise<readonly string[]>
    readFile(path: string, encoding: 'utf8'): Promise<string>
    stat(path: string): Promise<{ readonly uid: number; isSocket(): boolean }>
  }
}

/**
 * Inspect announced displays and OS session records without invoking GUI APIs.
 * A detected session does not establish permission or a reachable VNC service;
 * unreadable records remain unknown. Native providers may expose an explicit
 * configuration override for desktops not announced through these OS records.
 * @param internals - host facts and read-only filesystem operations.
 * @returns detected, not detected, or unverified desktop-session evidence.
 */
export async function inspectDesktopEnvironment(internals: DesktopEnvironmentInternals = {}): Promise<DesktopEnvironment> {
  const platform = internals.platform ?? process.platform
  const env = internals.env ?? process.env
  const files = internals.files ?? { readdir, readFile, stat }
  if (platform !== 'linux' && platform !== 'darwin') return { state: 'unknown', reason: 'platform-unverified' }
  try {
    if (platform === 'darwin') {
      const console = await files.stat('/dev/console')
      return console.uid > 0
        ? { state: 'detected', reason: 'console-user' }
        : { state: 'not-detected', reason: 'no-graphical-session' }
    }
    if (env.DISPLAY?.trim() || env.WAYLAND_DISPLAY?.trim()) return { state: 'detected', reason: 'display-environment' }
    let sessions: readonly string[]
    try { sessions = await files.readdir('/run/systemd/sessions') } catch (error) {
      if (!absent(error)) throw error
      sessions = []
    }
    for (const name of sessions) {
      if (!/^[a-zA-Z0-9-]+$/u.test(name)) continue
      let text: string
      try { text = await files.readFile(join('/run/systemd/sessions', name), 'utf8') } catch (error) {
        if (absent(error)) continue
        throw error
      }
      if (/^TYPE=(?:x11|wayland)$/mu.test(text) && !/^STATE=closing$/mu.test(text)) {
        return { state: 'detected', reason: 'graphical-session' }
      }
    }
    let displays: readonly string[]
    try { displays = await files.readdir('/tmp/.X11-unix') } catch (error) {
      if (!absent(error)) throw error
      displays = []
    }
    for (const name of displays) {
      if (!/^X[0-9]+$/u.test(name)) continue
      try {
        if ((await files.stat(join('/tmp/.X11-unix', name))).isSocket()) return { state: 'detected', reason: 'display-socket' }
      } catch (error) { if (!absent(error)) throw error }
    }
    return { state: 'not-detected', reason: 'no-graphical-session' }
  } catch (error) {
    if (!unreadable(error)) throw error
    return { state: 'unknown', reason: 'inspection-unavailable' }
  }
}

function absent(error: unknown): boolean {
  return error instanceof Error && 'code' in error && (error.code === 'ENOENT' || error.code === 'ENOTDIR')
}

function unreadable(error: unknown): boolean {
  return absent(error) || error instanceof Error && 'code' in error
    && (error.code === 'EACCES' || error.code === 'EPERM' || error.code === 'EIO')
}
