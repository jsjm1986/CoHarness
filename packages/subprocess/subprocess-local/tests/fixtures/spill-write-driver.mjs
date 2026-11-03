/** Isolated app fixture: real Loader, local process and partial recovery-file syscalls. */
import fs from 'node:fs'
import { readFile, rm } from 'node:fs/promises'
import { syncBuiltinESMExports } from 'node:module'
import { basename } from 'node:path'

const config = process.argv[2], bootEntry = process.env.DSH_SPILL_BOOT_ENTRY
if (config === undefined || bootEntry === undefined) throw new Error('Spill fixture requires config and a boot module')
const original = { openSync: fs.openSync, closeSync: fs.closeSync, writeSync: fs.writeSync }
const owned = new Set()
let partialWrites = 0, continuedWrites = 0
fs.openSync = (...args) => {
  const fd = original.openSync(...args)
  if (typeof args[0] === 'string' && basename(args[0]).startsWith('dsh-subprocess-')) owned.add(fd)
  return fd
}
fs.closeSync = (fd) => { original.closeSync(fd); owned.delete(fd) }
fs.writeSync = (...args) => {
  const [fd, data] = args
  if (!owned.has(fd) || !Buffer.isBuffer(data)) return original.writeSync(...args)
  const offset = args[2] ?? 0, length = args[3] ?? data.byteLength - offset, position = args[4] ?? null
  if (length > 2) partialWrites += 1
  if (offset > 0) continuedWrites += 1
  return original.writeSync(fd, data, offset, Math.min(length, 2), position)
}
syncBuiltinESMExports()
let ctx, spillPath
try {
  const { boot, resolveConfigPath } = await import(bootEntry)
  ctx = await boot('subprocess-spill-write', resolveConfigPath(config, undefined))
  const executable = await ctx.subprocess.resolveExecutable(process.execPath)
  const handle = await ctx.subprocess.spawn({ argv: [executable, '-e', "process.stdout.write('abcdefghijklm')"],
    cwd: process.cwd(), graceMs: 100,
    stdio: { stdin: 'ignore', stdout: { maxBytes: 4, spill: { maxBytes: 100 } }, stderr: { maxBytes: 4 } } })
  const outcome = await handle.done
  if (outcome.exitCode !== 0 || outcome.signal !== null) throw new Error('Real spill process did not finish successfully')
  const quiescent = await handle.waitForExit()
  const output = handle.collected.stdout?.readFrom(0)
  if (output?.spillPath === undefined) throw new Error('Real process did not publish a complete recovery file')
  spillPath = output.spillPath
  const full = await readFile(spillPath, 'utf8')
  process.stdout.write(`${JSON.stringify({ text: output.text, totalBytes: output.nextOffset, lossy: output.lossy,
    full, partialWritesRetried: partialWrites > 0 && continuedWrites > 0, quiescent })}\n`)
} finally {
  try { await ctx?.fiber.dispose() }
  finally {
    Object.assign(fs, original)
    syncBuiltinESMExports()
    if (spillPath !== undefined) await rm(spillPath, { force: true })
  }
}
