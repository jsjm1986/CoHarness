import { chmodSync, statSync } from 'node:fs'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  loadOrganizationModelCredentialKey,
  OrganizationModelCredentialCipher,
} from '../src/organization-model-credentials.ts'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

describe('organization model credential encryption', () => {
  it('creates one stable owner-only 32-byte master key', async () => {
    const root = await mkdtemp(join(tmpdir(), 'hgw-model-key-'))
    roots.push(root)
    const path = join(root, 'private', 'model.key')

    const first = loadOrganizationModelCredentialKey(path)
    const second = loadOrganizationModelCredentialKey(path)
    expect(first).toEqual(second)
    expect(first).toHaveLength(32)
    expect((await readFile(path, 'utf8')).trim()).toBe(first.toString('base64url'))
    if (process.platform !== 'win32') {
      expect(statSync(path).mode & 0o777).toBe(0o600)
      expect(statSync(join(root, 'private')).mode & 0o777).toBe(0o700)
    }
  })

  it('authenticates the organization and Provider as additional data', () => {
    const cipher = new OrganizationModelCredentialCipher(Buffer.alloc(32, 9))
    const encrypted = cipher.encrypt('organization-1', 'provider-1', 'sk-secret')

    expect(cipher.decrypt('organization-1', 'provider-1', encrypted)).toBe('sk-secret')
    expect(() => cipher.decrypt('organization-1', 'provider-2', encrypted)).toThrow()
    expect(() => cipher.decrypt('organization-2', 'provider-1', encrypted)).toThrow()
  })

  it('rejects a master key file readable by another POSIX user class', async () => {
    if (process.platform === 'win32') return
    const root = await mkdtemp(join(tmpdir(), 'hgw-model-key-mode-'))
    roots.push(root)
    const path = join(root, 'model.key')
    loadOrganizationModelCredentialKey(path)
    chmodSync(path, 0o644)

    expect(() => loadOrganizationModelCredentialKey(path)).toThrow(/owner-only/)
  })
})
