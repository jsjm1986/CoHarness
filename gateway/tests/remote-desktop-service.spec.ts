/** File round-trips of the administrator remote-desktop store. */
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { RemoteDesktopService, RemoteDesktopServiceError } from '../src/remote-desktop-service.ts'

const dirs: string[] = []
afterEach(async () => {
  await Promise.all(dirs.splice(0).map(d => rm(d, { recursive: true, force: true })))
})

async function service(): Promise<RemoteDesktopService> {
  const dir = await mkdtemp(join(tmpdir(), 'remote-desktop-'))
  dirs.push(dir)
  return new RemoteDesktopService(dir)
}

describe('RemoteDesktopService', () => {
  it('seeds this host\'s screen-sharing endpoint on a fresh directory', async () => {
    const svc = await service()
    const rows = await svc.endpoints()
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ host: '127.0.0.1', port: 5900 })
    const text = await readFile(join(svc.dir, 'endpoints.json'), 'utf8')
    expect(JSON.parse(text)).toEqual({ endpoints: rows })
  })

  it('round-trips endpoints and rejects duplicates', async () => {
    const svc = await service()
    const rows = await svc.saveEndpoints([{ nodeId: 'mac-mini', host: '127.0.0.1', port: 5900 }])
    expect(rows).toHaveLength(1)
    expect(await svc.endpoints()).toEqual(rows)
    const text = await readFile(join(svc.dir, 'endpoints.json'), 'utf8')
    expect(JSON.parse(text)).toEqual({ endpoints: rows })
    await expect(svc.saveEndpoints([rows[0], rows[0]])).rejects.toBeInstanceOf(RemoteDesktopServiceError)
  })

  it('writes grants in the provider JSONL format and mutates them', async () => {
    const svc = await service()
    await svc.saveEndpoints([{ nodeId: 'mac-mini', host: '127.0.0.1', port: 5900 }])
    const grant = await svc.createGrant({
      principal: 'alice', target: { nodeId: 'mac-mini' }, level: 'control', recording: true,
    }, 'admin')
    expect(grant.scope).toEqual({ kind: 'machine' })
    const line = (await readFile(join(svc.dir, 'grants.jsonl'), 'utf8')).trim()
    expect(JSON.parse(line)).toEqual(grant)
    expect((await svc.setLevel(grant.id, 'view')).level).toBe('view')
    expect((await svc.revoke(grant.id)).revokedAt).toBeTypeOf('number')
    await expect(svc.revoke(grant.id)).rejects.toBeInstanceOf(RemoteDesktopServiceError)
  })

  it('rejects grants against unconfigured targets', async () => {
    const svc = await service()
    await svc.saveEndpoints([{ nodeId: 'mac-mini', host: '127.0.0.1', port: 5900 }])
    await expect(svc.createGrant({
      principal: 'alice', target: { nodeId: 'other' }, level: 'view', recording: false,
    }, 'admin')).rejects.toMatchObject({ status: 400 })
  })

  it('tails the provider audit file', async () => {
    const svc = await service()
    await writeFile(join(svc.dir, 'audit.jsonl'),
      `${JSON.stringify({ kind: 'attach', principal: 'alice', at: 1 })}\n${JSON.stringify({ kind: 'detach', at: 2 })}\n`)
    const events = await svc.audit(10)
    expect(events.map(e => e.kind)).toEqual(['attach', 'detach'])
  })
})
