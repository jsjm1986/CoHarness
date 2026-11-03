/** Native child stderr exercises byte clipping and stream decoder boundaries. */
import assert from 'node:assert/strict'
import { writeFile } from 'node:fs/promises'
import { join, resolve, sep } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const [mode, root, artifact] = process.argv.slice(2)
assert.ok(mode === 'src' || mode === 'lib')
const moduleUrl = mode === 'src' ? new URL('../../src/deployment-commands.ts', import.meta.url)
  : new URL('deployment-commands.js', pathToFileURL(resolve(artifact || fileURLToPath(new URL('../../lib/', import.meta.url))) + sep))
const { createDeploymentCommands, DeploymentCommandError } = await import(moduleUrl)
const reader = join(root, 'reader.mjs'), dump = join(root, 'archive.dump')
await writeFile(dump, 'fixture archive')
for (const [name, text] of [
  ['ascii-overflow', 'error: ' + 'a'.repeat(64 * 1024)],
  ['utf8-overflow', 'error: ' + '中'.repeat(10_000)],
  ['emoji-overflow', 'error: ' + '😀'.repeat(10_000)],
  ['utf8-exact', 'error: ' + '中'.repeat(2728) + 'a'],
]) {
  await writeFile(reader, `const bytes = Buffer.from(${JSON.stringify(text)})
    const cut = ${name === 'ascii-overflow' ? 'bytes.length' : '8192'}
    process.stdin.once('data', () => {
      process.stderr.write(bytes.subarray(0, cut), () => {
        process.stderr.write(bytes.subarray(cut), () => { process.exitCode = 7; process.stdin.resume() })
      })
    })\n`)
  const command = [process.execPath, reader]
  let failure
  try { await createDeploymentCommands(command, command).verifyDump(dump) } catch (error) { failure = error }
  assert.ok(failure instanceof DeploymentCommandError)
  assert.match(failure.message, /deployment command failed \(exit 7\)/u)
  const marker = ' — ', at = failure.message.indexOf(marker)
  assert.ok(at >= 0)
  const detail = failure.message.slice(at + marker.length)
  process.stdout.write(JSON.stringify({ case: name, bytes: Buffer.byteLength(detail),
    completePrefix: text.startsWith(detail) && !detail.includes('\uFFFD') }) + '\n')
}
