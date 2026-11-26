/** Native personal validation and reconstruction share the serving engine's bounded write admission. */
import { readFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { personalNativeFixture } from './peer-backup-personal-native-fixture.ts'
import { readPersonalRecoveryPoint, restorePeerPersonalFiles, validatePeerPersonal } from '../src/peer-backup-personal.ts'
import { PeerBackupSourceSpace, type PeerSourceWrites } from '../src/peer-backup-source-space.ts'
import { postgresTestDatabaseUrl } from './postgres-test-database.mjs'

const databaseUrl=postgresTestDatabaseUrl(process.env.HGW_TEST_DATABASE_URL)

it.skipIf(databaseUrl===undefined || !process.env.HGW_TEST_NODE_CONTENT_PGDATA)(
  'refuses native verification and reconstruction allocations without altering source tasks or retaining private copies',
  () => personalNativeFixture(async f => {
    const schedule = join(f.home, 'storages', 'schedule.json'), originalSchedule = await readFile(schedule)
    let free = 256 << 20, copied = 0
    const owner = new PeerBackupSourceSpace(f.limits.reserveBytes,
      async () => ({ bavail: BigInt(Math.floor(free / 4096)), bsize: 4096n }))
    const shared = owner.operation(f.signal)
    const limited: PeerSourceWrites = { ...shared, write: (path, bytes, write, entries) => shared.write(path, bytes, async () => {
      const result = await write()
      if (path.includes('personal-verification-') && bytes > 0) { copied += bytes; free = f.limits.reserveBytes }
      return result
    }, entries) }
    await expect(validatePeerPersonal(f.binding, f.captured, f.payload, f.signal, f.limits, limited))
      .rejects.toMatchObject({ status: 507, code: 'peer-backup/source-capacity' })
    expect(copied).toBeGreaterThan(0)
    expect((await readdir(f.root)).filter(name => name.startsWith('personal-verification-'))).toEqual([])
    expect(await readFile(schedule)).toEqual(originalSchedule)

    let enter!: () => void, release!: () => void
    const entered = new Promise<void>(done => { enter = done }), proceed = new Promise<void>(done => { release = done })
    free = 256 << 20
    const competing = owner.operation(f.signal).write(f.root, 8192, async () => { enter(); await proceed; free = f.limits.reserveBytes })
    await entered
    const refused = expect(readPersonalRecoveryPoint(f.binding, f.captured, f.payload, f.limits, f.signal, owner.operation(f.signal)))
      .rejects.toMatchObject({ status: 507, code: 'peer-backup/source-capacity' })
    release(); await competing; await refused
    expect((await readdir(f.root)).filter(name => name.startsWith('personal-verification-'))).toEqual([])

    free = 256 << 20
    const destination = join(f.root, 'refused-reconstruction')
    const restoration: PeerSourceWrites = { ...shared, write: (path, bytes, write, entries) => {
      if (path === join(destination, 'node-state') && bytes > 0) free = f.limits.reserveBytes
      return shared.write(path, bytes, write, entries)
    } }
    await expect(restorePeerPersonalFiles(f.binding, f.captured, f.payload, destination, f.limits, f.signal, restoration))
      .rejects.toMatchObject({ status: 507, code: 'peer-backup/source-capacity' })
    expect(await readdir(f.root)).not.toContain('refused-reconstruction')
    expect(await readFile(schedule)).toEqual(originalSchedule)
    const recovered = await readPersonalRecoveryPoint(f.binding, f.captured, f.payload, f.limits, f.signal)
    expect(recovered.recovery.oldSessionIds).toEqual(['old-child', 'old-root'])
  }), 120000,
)
