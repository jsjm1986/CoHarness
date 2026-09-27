/** Verify the relocated deployment payload through its installed interpreters. */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { parseArgs } from 'node:util'
import { installPrimaryRuntime, readPrimaryRuntime } from '../../packages/boot/workspace-dependencies/src/primary-runtime.ts'
import { smokePrimaryRuntime } from './prepare.ts'

const { values } = parseArgs({ options: { source: { type: 'string' } } })
if (values.source === undefined) throw new Error('Usage: verify-installed.ts --source <payload directory>')
const source = resolve(values.source)
const temporary = await mkdtemp(join(tmpdir(), 'coharness-installed-interpreters-'))
try {
  const installed = join(temporary, 'relocated runtime')
  await installPrimaryRuntime(source, installed)
  smokePrimaryRuntime(installed)
  const manifest = await readPrimaryRuntime(installed)
  console.log(JSON.stringify({ platform: manifest.platform, arch: manifest.arch,
    payloadDigest: manifest.payloadDigest, executionVerified: true, relocated: true }))
} finally {
  await rm(temporary, { recursive: true, force: true })
}
