/** Verify lease recovery against an isolated Linux Btrfs mount while other file writers continue. */
import assert from 'node:assert/strict'
import { fork } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { once } from 'node:events'
import { lstat, readFile, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { openPeerBtrfsSnapshot } from '../../lib/peer-btrfs-snapshot.js'

const [mode, source, staging] = process.argv.slice(2)
const capture = () => openPeerBtrfsSnapshot(source, staging, 15000, new AbortController().signal)
if (mode === 'hold') {
  const snapshot = await capture()
  process.on('message', async () => {
    await snapshot.release()
    process.disconnect()
  })
  process.send({ root: snapshot.root, id: snapshot.id })
} else {
  assert.equal(mode, 'verify')
  const file = join(source, 'task.txt')
  await writeFile(file, 'first')
  const holder = fork(fileURLToPath(import.meta.url), ['hold', source, staging], { stdio: ['ignore', 'ignore', 'inherit', 'ipc'] })
  const closed = once(holder, 'close')
  try {
    const [{ root, id }] = await Promise.race([once(holder, 'message'), closed.then(() => { throw new Error('Snapshot holder exited before capture') })])
    const live = await capture()
    try {
      await writeFile(file, 'second')
      await live.confirm()
      assert.equal(await readFile(join(root, 'task.txt'), 'utf8'), 'first')
      holder.kill('SIGKILL')
      await closed
      assert.ok(root.endsWith('.' + id))
      const different = root.slice(0, -id.length) + randomUUID()
      await rename(root, different)
      try {
        await assert.rejects(capture(), error => error.code === 'peer-backup/btrfs-snapshot-unavailable')
        assert.equal(await readFile(join(different, 'task.txt'), 'utf8'), 'first')
      } finally { await rename(different, root) }
      const next = await capture()
      try {
        await assert.rejects(lstat(root), error => error.code === 'ENOENT')
        await live.confirm()
        assert.equal(await readFile(live.map(file), 'utf8'), 'first')
        assert.equal(await readFile(next.map(file), 'utf8'), 'second')
      } finally { await next.release() }
    } finally { await live.release() }
    assert.equal(await readFile(file, 'utf8'), 'second')
    console.log(JSON.stringify({ provider: 'btrfs', concurrentOwnerPreserved: true, ownerKilled: true, replacedIdentityRejected: true, abandonedViewReleased: true }))
  } finally {
    if (holder.exitCode === null && holder.signalCode === null) holder.kill('SIGKILL')
    await closed
  }
}
