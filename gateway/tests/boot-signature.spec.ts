import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { testConfig } from './test-config.ts'
import { readBootSignature, reconcileBootSignature, runtimeBootSignature, writeBootSignature } from '../src/boot-signature.ts'

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function fixture(): string {
  const root = mkdtempSync(join(tmpdir(), 'hgw-boot-signature-'))
  roots.push(root)
  return root
}

describe('runtime boot signature', () => {
  it('round-trips a signature and reports missing or malformed records as absent', async () => {
    const root = fixture()
    const cfg = testConfig(root, { HGW_DSH_REPO_ROOT: root })
    expect(await readBootSignature(cfg.stateRoot)).toBeUndefined()
    const signature = await runtimeBootSignature(cfg)
    await writeBootSignature(cfg.stateRoot, signature)
    expect(await readBootSignature(cfg.stateRoot)).toEqual(signature)
    writeFileSync(join(cfg.stateRoot, 'boot-signature.json'), '{"version":99')
    expect(await readBootSignature(cfg.stateRoot)).toBeUndefined()
    writeFileSync(join(cfg.stateRoot, 'boot-signature.json'), '{"version":2,"releaseRoot":"x","gitHead":"","nodeExecPath":"x","nodeVersion":"v1","entrySha256":"","entryCommand":[],"repoSha256":"","supervisorSha256":""}')
    expect(await readBootSignature(cfg.stateRoot)).toBeUndefined()
  })

  it('changes when the Runtime entry script content changes and stays stable otherwise', async () => {
    const root = fixture()
    const entry = join(root, 'entry.js')
    writeFileSync(entry, 'console.log(1)\n')
    const cfg = testConfig(root, { HGW_DSH_REPO_ROOT: root })
    cfg.dshCommand = [process.execPath, entry]
    const before = await runtimeBootSignature(cfg)
    expect(before.entrySha256).not.toBe('')
    expect(await runtimeBootSignature(cfg)).toEqual(before)
    writeFileSync(entry, 'console.log(2)\n')
    const after = await runtimeBootSignature(cfg)
    expect({ ...after, entrySha256: '' }).toEqual({ ...before, entrySha256: '' })
    expect(after.entrySha256).not.toBe(before.entrySha256)
  })

  it('changes when the release root moves', async () => {
    const root = fixture()
    const cfg = testConfig(root, { HGW_DSH_REPO_ROOT: root })
    cfg.dshCommand = [process.execPath, '-e', 'code']
    cfg.releaseRoot = join(root, 'releases', 'r1')
    const first = await runtimeBootSignature(cfg)
    cfg.releaseRoot = join(root, 'releases', 'r2')
    const second = await runtimeBootSignature(cfg)
    expect(second.releaseRoot).not.toBe(first.releaseRoot)
  })

  it('keeps the prior signature when the survivor drain fails so the next boot retries', async () => {
    const root = fixture()
    const cfg = testConfig(root, { HGW_DSH_REPO_ROOT: root })
    cfg.releaseRoot = join(root, 'releases', 'r1')
    const prior = await runtimeBootSignature(cfg)
    await writeBootSignature(cfg.stateRoot, prior)
    cfg.releaseRoot = join(root, 'releases', 'r2')
    const next = await runtimeBootSignature(cfg)

    let drained = 0
    const error = await reconcileBootSignature(cfg.stateRoot, next, () => {
      drained += 1
      return Promise.reject(new Error('database unavailable'))
    })
    expect(error).toBe('undrained')
    expect(drained).toBe(1)
    // The failed drain must not certify the new launch identity.
    expect(await readBootSignature(cfg.stateRoot)).toEqual(prior)

    expect(await reconcileBootSignature(cfg.stateRoot, next, () => { drained += 1; return Promise.resolve() }))
      .toBe('drained')
    expect(await readBootSignature(cfg.stateRoot)).toEqual(next)
    expect(await reconcileBootSignature(cfg.stateRoot, next, () => { drained += 1; return Promise.resolve() }))
      .toBe('retained')
    expect(drained).toBe(2)
  })
})
