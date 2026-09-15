import { describe, expect, it } from 'vitest'
import { mkdtemp, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  defaultWorkspaceTitle,
  fullyQualifiedWorkspacePath,
  realpathNormalize,
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

describe('realpathNormalize', () => {
  it('rejects paths that are not fully qualified', async () => {
    await expect(realpathNormalize('relative/dir')).rejects.toThrow(TypeError)
  })

  it('resolves a fully qualified directory through realpath', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dsh-workspace-paths-'))
    try {
      expect(await realpathNormalize(dir)).toBe(await realpath(dir))
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})
