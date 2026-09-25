import { describe, expect, it, vi } from 'vitest'
import { mkdtemp, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import LocalFileSystem from '@deepseek-ai/dsh-fs-local'
import { FsTargetKey, FsVersion } from '@deepseek-ai/dsh-fs'
import type { FileSystem } from '@deepseek-ai/dsh-fs'
import {
  defaultWorkspaceTitle,
  fullyQualifiedWorkspacePath,
  resolveWorkspacePath,
} from '../src/paths.ts'

describe('fullyQualifiedWorkspacePath', () => {
  it('accepts absolute posix paths and rejects relative ones', () => {
    expect(fullyQualifiedWorkspacePath('/tmp/ws', 'linux')).toBe(true)
    expect(fullyQualifiedWorkspacePath('tmp/ws', 'linux')).toBe(false)
    expect(fullyQualifiedWorkspacePath('C:\\ws', 'linux')).toBe(false)
  })

  it('rejects drive-relative and share-root spellings on win32', () => {
    expect(fullyQualifiedWorkspacePath('C:\\ws', 'win32')).toBe(true)
    expect(fullyQualifiedWorkspacePath('\\ws', 'win32')).toBe(false)
    expect(fullyQualifiedWorkspacePath('/ws', 'win32')).toBe(false)
    expect(fullyQualifiedWorkspacePath('ws\\dir', 'win32')).toBe(false)
  })
})

describe('defaultWorkspaceTitle', () => {
  it('uses the final path segment', () => {
    expect(defaultWorkspaceTitle('/a/b', 'linux')).toBe('b')
    expect(defaultWorkspaceTitle('C:\\a\\b', 'win32')).toBe('b')
  })

  it('falls back to the root spelling when no segment exists', () => {
    expect(defaultWorkspaceTitle('C:\\', 'win32')).toBe('C:\\')
  })
})

describe('resolveWorkspacePath', () => {
  it('rejects paths that are not fully qualified', async () => {
    const resolve = vi.fn()
    await expect(resolveWorkspacePath('relative/dir', { resolve } as unknown as FileSystem)).rejects.toThrow(TypeError)
    expect(resolve).not.toHaveBeenCalled()
  })

  it('resolves a fully qualified directory through realpath', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dsh-workspace-paths-'))
    const ctx = new Context()
    try {
      await ctx.plugin(LocalFileSystem, { cwd: dir })
      expect(await resolveWorkspacePath(dir, ctx.fs)).toMatchObject({ path: await realpath(dir), info: { type: 'directory' } })
    } finally {
      await ctx.fiber.dispose()
      await rm(dir, { recursive: true, force: true })
    }
  })
})


describe('execution-target paths', () => {
  it('uses provider process paths without interpreting opaque target keys', async () => {
    const target = { targetKey: FsTargetKey('remote:opaque:42'), displayPath: '/remote/link' }
    const info = { type: 'directory' as const, version: FsVersion('remote-v1') }
    const filesystem = { resolve: vi.fn(async () => target), stat: vi.fn(async () => info), processPath: vi.fn(() => '/remote/canonical') }
    expect(await resolveWorkspacePath('/remote/link', filesystem as unknown as FileSystem)).toEqual({ path: '/remote/canonical', info })
    expect(filesystem.stat).toHaveBeenCalledWith(target)
    expect(filesystem.processPath).toHaveBeenCalledWith(target)
  })

  it('rejects a remote missing path even when that path exists on the Host', async () => {
    const filesystem = { resolve: vi.fn(async () => ({ targetKey: FsTargetKey('remote:missing'), displayPath: process.cwd() })), stat: vi.fn(async () => undefined), processPath: vi.fn() }
    await expect(resolveWorkspacePath(process.cwd(), filesystem as unknown as FileSystem)).rejects.toMatchObject({ code: 'FS_NOT_FOUND' })
    expect(filesystem.processPath).not.toHaveBeenCalled()
  })

  it('preserves provider connection failures without reading a Host directory', async () => {
    const failure = new Error('SSH connection closed')
    const filesystem = { resolve: vi.fn(async () => { throw failure }) }
    await expect(resolveWorkspacePath(process.cwd(), filesystem as unknown as FileSystem)).rejects.toBe(failure)
  })
})
