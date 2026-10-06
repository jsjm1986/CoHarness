import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { preparePrimaryRuntime, primaryRuntimePayloadDigest, smokePrimaryRuntime } from './prepare.ts'
import { declareRuntimeLockContract } from '../primary-runtime/lock-contract.ts'
import lock from './primary-runtime-lock.json' with { type: 'json' }

declareRuntimeLockContract(lock, primaryRuntimePayloadDigest)

it('reports missing distribution metadata before trying to execute a stale native payload', async () => {
  const root = await mkdtemp(join(tmpdir(), 'desktop-stale-runtime-'))
  try {
    await writeFile(join(root, 'runtime.json'), JSON.stringify({ platform: process.platform, arch: process.arch }))
    expect(() => { smokePrimaryRuntime(root) }).toThrow('missing Python distribution versions; prepare the payload')
  } finally { await rm(root, { recursive: true, force: true }) }
})

it('refuses an existing output and never counts a foreign payload as executed', async () => {
  const root = await mkdtemp(join(tmpdir(), 'coharness-runtime-output-'))
  try {
    await expect(preparePrimaryRuntime({ target: 'mac-arm64', output: root, cache: join(root, 'cache') }))
      .rejects.toThrow('output already exists')
    await writeFile(join(root, 'runtime.json'), JSON.stringify({ platform: 'other', arch: process.arch }))
    expect(() => { smokePrimaryRuntime(root) }).toThrow('native smoke requires')
    const target = process.platform === 'win32' ? 'mac-arm64' : 'win-x64'
    await expect(preparePrimaryRuntime({ target, output: join(root, 'output'), cache: join(root, 'cache') }))
      .rejects.toThrow('target cannot execute')
  } finally { await rm(root, { recursive: true, force: true }) }
})
