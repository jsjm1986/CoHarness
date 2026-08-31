import { mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { removeBootstrapAdminPassword, writeBootstrapAdminPassword } from '../src/bootstrap-admin.ts'

describe('bootstrap administrator password delivery', () => {
  it('writes one owner-only file and refuses overwrite', async () => {
    const root = await mkdtemp(join(tmpdir(), 'hgw-bootstrap-'))
    const path = join(root, 'nested', 'bootstrap-password')
    try {
      await writeBootstrapAdminPassword(path, 'generated-secret')
      expect(await readFile(path, 'utf8')).toBe('generated-secret\n')
      expect((await stat(path)).mode & 0o777).toBe(0o600)
      await expect(writeBootstrapAdminPassword(path, 'replacement')).rejects.toThrow(/already exists/)
      await removeBootstrapAdminPassword(path)
      await expect(removeBootstrapAdminPassword(path)).resolves.toBeUndefined()
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('rejects an invalid destination or empty password', async () => {
    await expect(writeBootstrapAdminPassword('relative/password', 'secret')).rejects.toThrow(/invalid/)
    await expect(writeBootstrapAdminPassword('/tmp/password', '')).rejects.toThrow(/invalid/)
  })
})
