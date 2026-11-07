/** File round-trips of the administrator remote-desktop store. */
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { RemoteDesktopService, RemoteDesktopServiceError } from '../src/remote-desktop-service.ts'

const dirs: string[] = []
afterEach(async () => {
  await Promise.all(dirs.splice(0).map(d => rm(d, { recursive: true, force: true })))
})

async function service(state: 'detected' | 'not-detected' = 'detected'): Promise<RemoteDesktopService> {
  const dir = await mkdtemp(join(tmpdir(), 'remote-desktop-'))
  dirs.push(dir)
  return new RemoteDesktopService(dir, { run: (_actorUserId, operation) => operation('admin', new AbortController().signal) },
    async () => ({ state, reason: state === 'detected' ? 'console-user' : 'no-graphical-session' }))
}

describe('RemoteDesktopService', () => {
  it('keeps a fresh headless host empty and preserves explicitly configured VNC targets', async () => {
    const svc = await service('not-detected')
    expect(await svc.endpoints(7)).toEqual([])
    const configured = [{ nodeId: 'virtual-desktop', host: '192.0.2.20', port: 5901 }]
    await svc.saveEndpoints(configured, 7)
    expect(await svc.endpoints(7)).toEqual(configured)
  })
  it('seeds this host\'s screen-sharing endpoint on a fresh directory', async () => {
    const svc = await service()
    const rows = await svc.endpoints(7)
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ host: '127.0.0.1', port: 5900 })
    const text = await readFile(join(svc.dir, 'endpoints.json'), 'utf8')
    expect(JSON.parse(text)).toEqual({ endpoints: rows })
  })

  it('round-trips endpoints and rejects duplicates', async () => {
    const svc = await service()
    const rows = await svc.saveEndpoints([{ nodeId: 'mac-mini', host: '127.0.0.1', port: 5900 }], 7)
    expect(rows).toHaveLength(1)
    expect(await svc.endpoints(7)).toEqual(rows)
    const text = await readFile(join(svc.dir, 'endpoints.json'), 'utf8')
    expect(JSON.parse(text)).toEqual({ endpoints: rows })
    await expect(svc.saveEndpoints([rows[0], rows[0]], 7)).rejects.toBeInstanceOf(RemoteDesktopServiceError)
  })

  it('persists managed-credential fields and rejects invalid combinations', async () => {
    const svc = await service()
    const rows = await svc.saveEndpoints([{
      nodeId: 'mac-mini', host: '127.0.0.1', port: 5900, username: 'alice', passwordRef: 'VNC_PASSWORD_MAC_MINI',
    }], 7)
    expect(rows[0]).toMatchObject({ username: 'alice', passwordRef: 'VNC_PASSWORD_MAC_MINI' })
    const text = await readFile(join(svc.dir, 'endpoints.json'), 'utf8')
    expect(JSON.parse(text)).toEqual({ endpoints: rows })
    await expect(svc.saveEndpoints([{
      nodeId: 'mac-mini', host: '127.0.0.1', port: 5900, username: 'alice',
    }], 7)).rejects.toMatchObject({ status: 400, message: 'remote-desktop-username-without-passwordref' })
    for (const passwordRef of ['9VNC', 'VNC-PASSWORD', 'VNC PASSWORD', 'a'.repeat(129)]) {
      await expect(svc.saveEndpoints([{
        nodeId: 'mac-mini', host: '127.0.0.1', port: 5900, passwordRef,
      }], 7)).rejects.toMatchObject({ status: 400, message: 'remote-desktop-passwordref-invalid' })
    }
  })

  it('writes grants in the provider JSONL format and mutates them', async () => {
    const svc = await service()
    await svc.saveEndpoints([{ nodeId: 'mac-mini', host: '127.0.0.1', port: 5900 }], 7)
    const grant = await svc.createGrant({
      principal: 'alice', target: { nodeId: 'mac-mini' }, level: 'control', recording: true,
    }, 7)
    expect(grant.scope).toEqual({ kind: 'machine' })
    const line = (await readFile(join(svc.dir, 'grants.jsonl'), 'utf8')).trim()
    expect(JSON.parse(line)).toEqual(grant)
    expect((await svc.setLevel(grant.id, 'view', 7)).level).toBe('view')
    expect((await svc.revoke(grant.id, 7)).revokedAt).toBeTypeOf('number')
    await expect(svc.revoke(grant.id, 7)).rejects.toBeInstanceOf(RemoteDesktopServiceError)
  })

  it('rejects grants against unconfigured targets', async () => {
    const svc = await service()
    await svc.saveEndpoints([{ nodeId: 'mac-mini', host: '127.0.0.1', port: 5900 }], 7)
    await expect(svc.createGrant({
      principal: 'alice', target: { nodeId: 'other' }, level: 'view', recording: false,
    }, 7)).rejects.toMatchObject({ status: 400 })
  })

  it('tails the provider audit file', async () => {
    const svc = await service()
    await writeFile(join(svc.dir, 'audit.jsonl'),
      `${JSON.stringify({ kind: 'attach', principal: 'alice', at: 1 })}\n${JSON.stringify({ kind: 'detach', at: 2 })}\n`)
    const events = await svc.audit(10, 7)
    expect(events.map(e => e.kind)).toEqual(['attach', 'detach'])
  })

  it.skipIf(process.platform === 'win32' || process.getuid?.() === 0)('preserves configured endpoints after a read permission failure', async () => {
    const svc = await service(), file = join(svc.dir, 'endpoints.json')
    await svc.saveEndpoints([{ nodeId: 'configured', host: 'configured.example', port: 5901 }], 7)
    const committed = await readFile(file, 'utf8')
    await chmod(file, 0)
    try {
      await expect(svc.endpoints(7)).rejects.toMatchObject({ status: 503, message: 'remote-desktop-store-unavailable' })
    } finally { await chmod(file, 0o600) }
    expect(await readFile(file, 'utf8')).toBe(committed)
  })

  it.skipIf(process.platform === 'win32' || process.getuid?.() === 0)('preserves existing grants after a read permission failure', async () => {
    const svc = await service(), file = join(svc.dir, 'grants.jsonl')
    await svc.saveEndpoints([{ nodeId: 'configured', host: 'configured.example', port: 5901 }], 7)
    await svc.createGrant({ principal: 'alice', target: { nodeId: 'configured' }, level: 'view' }, 7)
    const committed = await readFile(file, 'utf8')
    await chmod(file, 0)
    try {
      await expect(svc.createGrant({ principal: 'bob', target: { nodeId: 'configured' }, level: 'control' }, 7))
        .rejects.toMatchObject({ status: 503, message: 'remote-desktop-store-unavailable' })
    } finally { await chmod(file, 0o600) }
    expect(await readFile(file, 'utf8')).toBe(committed)
  })
})
