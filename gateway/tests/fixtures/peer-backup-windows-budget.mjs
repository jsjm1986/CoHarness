/** Bound the native Windows qualification process, SQLite workers and all restic children to one OS job. */
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { freemem } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
import { isMainThread } from 'node:worker_threads'

if (isMainThread) {
  const root = realpathSync(dirname(process.argv[1]))
  const stage = process.argv[2]
  assert.ok(['receive', 'send', 'verify'].includes(stage))
  assert.ok(/^hgw-peer-test-[\da-f-]{36}$/u.test(basename(root)))
  assert.equal(readFileSync(join(root, 'fixture-owner'), 'utf8'), basename(root))
  assert.equal(process.arch, 'x64')
  assert.equal(process.platform, 'win32')
  const moduleRoot = process.env.HGW_TEST_WINDOWS_JOB_ROOT
  const { loadWin32ProcessBindings, isNullPtr } = await import(pathToFileURL(join(moduleRoot, 'lib/index.js')).href)
  const koffi = createRequire(pathToFileURL(join(moduleRoot, 'package.json')))('koffi')
  const getSelf = koffi.load('kernel32.dll').func('void* __stdcall GetCurrentProcess()')
  const api = loadWin32ProcessBindings()
  const mib = 1024 ** 2
  const available = () => Math.floor(freemem() / mib)
  const before = available()
  const configured = Number(process.env.HGW_TEST_WINDOWS_JOB_MIB)
  assert.ok(Number.isInteger(configured) && configured >= 96 && configured <= 512)
  const cap = Math.min(configured, before - 300 + Math.min(32, Math.floor(process.memoryUsage().rss / mib)))
  assert.ok(before >= 382 && cap >= 96, 'Dedicated Windows backup memory reserve unavailable')
  const job = api.createJobObjectW(null, null)
  assert.ok(!isNullPtr(job))
  // On x64 JOBOBJECT_EXTENDED_LIMIT_INFORMATION puts the aggregate private commit limit at offset 120.
  const limits = Buffer.alloc(144)
  limits.writeUInt32LE(0x2200, 16)
  limits.writeBigUInt64LE(BigInt(cap) * BigInt(mib), 120)
  assert.notEqual(api.setInformationJobObject(job, 9, limits, limits.length), 0)
  const effective = Buffer.alloc(144)
  assert.notEqual(api.queryInformationJobObject(job, 9, effective, effective.length, null), 0)
  assert.equal(effective.readUInt32LE(16), 0x2200)
  assert.equal(effective.readBigUInt64LE(120), BigInt(cap) * BigInt(mib))
  assert.notEqual(api.assignProcessToJobObject(job, getSelf()), 0)
  let lowest = before
  const monitor = setInterval(() => {
    lowest = Math.min(lowest, available())
    if (lowest < 272) process.exit(79)
  }, 150)
  monitor.unref()
  process.on('exit', () => {
    api.queryInformationJobObject(job, 9, effective, effective.length, null)
    writeFileSync(join(root, stage + '-budget.json'), JSON.stringify({
      beforeMiB: before, lowestMiB: lowest, privateCommitCapMiB: cap, peakCommitMiB: Number(effective.readBigUInt64LE(136)) / mib,
    }), { flag: 'wx' })
  })
}
