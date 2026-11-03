/** Real sandbox plugin composition and native probe selection, without running a target command. */
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { Context } from '@deepseek-ai/cordis'

const [entry, runner, root] = process.argv.slice(2)
const { LocalSandboxProvider } = await import(pathToFileURL(entry).href)
const ctx = new Context(), fiber = await ctx.plugin(LocalSandboxProvider, { probeTimeoutMs: 5000 })
try {
  const sandbox = ctx.sandbox, binary = join(root, 'bwrap')
  switch (runner) {
    case 'bwrap': sandbox.internals = { platform: 'linux', probeLandlock: () => 'unusable' }; break
    case 'landlock': sandbox.internals = { platform: 'linux', probeBwrap: () => false, landlockLauncher: binary }; break
    case 'seatbelt': sandbox.internals = { chain: ['seatbelt', 'landlock'], seatbeltExec: binary, probeLandlock: () => 'unusable' }; break
    case 'windows-acl': sandbox.internals = { chain: ['windows-acl', 'bwrap'], windowsAclRunnerArgs: [binary], probeBwrap: () => false }; break
    default: throw new Error('Unknown probe fixture runner')
  }
  for (let attempt = 0; attempt < 2; attempt++) {
    await assert.rejects(sandbox.confine([process.execPath, '-e', ''], { mode: 'read-only', workspaceRoot: root }), { code: 'SANDBOX_UNAVAILABLE' })
  }
  assert.equal((await readFile(join(root, 'calls.jsonl'), 'utf8')).trim().split('\n').length, 1)
  process.stdout.write(`The ${runner} probe times out, closes its native client and caches unavailable confinement.\n`)
} finally { await fiber.dispose() }
