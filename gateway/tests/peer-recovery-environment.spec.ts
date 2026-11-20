/** Suspended-setting evidence contains names only and survives subsequent restore copies. */
import { mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { readRecoveryEnvironment, sealRecoveryEnvironment } from '../src/peer-recovery-environment.ts'

it('retains prior suspended names and rejects hidden values or links in the sealed notice', async () => {
  const home = await mkdtemp(join(tmpdir(), 'recovery-environment-'))
  const file = join(home, '.recovery-environment.json')
  try {
    expect(await readRecoveryEnvironment(home, 65536)).toEqual([])
    await sealRecoveryEnvironment(home, ['PGHOST'], 65536)
    expect(await sealRecoveryEnvironment(home, ['HGW_NODE_TOKEN', 'PGHOST'], 65536)).toEqual(['HGW_NODE_TOKEN', 'PGHOST'])
    const original = await readFile(file, 'utf8')
    expect(await readRecoveryEnvironment(home, 65536)).toEqual(['HGW_NODE_TOKEN', 'PGHOST'])
    expect(await readFile(file, 'utf8')).toBe(original)
    await writeFile(file, JSON.stringify({ version: 1, keys: ['PGHOST'], password: 'must-not-be-imported' }))
    await expect(readRecoveryEnvironment(home, 65536)).rejects.toMatchObject({ code: 'peer-backup/environment-evidence-incomplete' })
    await writeFile(file, '{broken')
    await expect(readRecoveryEnvironment(home, 65536)).rejects.toMatchObject({ code: 'peer-backup/environment-evidence-incomplete' })
    await rm(file)
    const external = join(home, 'unowned.json')
    await writeFile(external, original)
    await symlink(external, file)
    await expect(sealRecoveryEnvironment(home, ['PGPASSWORD'], 65536)).rejects.toMatchObject({ code: 'peer-backup/environment-evidence-incomplete' })
    expect(await readFile(external, 'utf8')).toBe(original)
  } finally { await rm(home, { recursive: true, force: true }) }
})
