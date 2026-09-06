import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it } from 'vitest'
import { SessionId, type SessionEvent, type SessionHeader } from '@deepseek-ai/dsh-session'
import SessionPersistence, {
  SessionAlreadyOwnedError,
  SessionPersistenceRevision,
  SessionReadOnlyError,
  type SessionInspection,
  type SessionLocation,
  type SessionPersistenceSnapshot,
} from '../src/index.ts'

class MemoryPersistence extends SessionPersistence {
  override readonly supportsRawArtifacts = false
  readonly appended: SessionEvent[][] = []

  locate(_meta: SessionHeader): SessionLocation | undefined { return undefined }
  async create(_meta: SessionHeader): Promise<void> {}
  async append(_id: SessionId, events: readonly SessionEvent[]): Promise<void> { this.appended.push([...events]) }
  async load(_id: SessionId): Promise<SessionInspection> { return { meta: header, events: [] } }
  async inspect(_id: SessionId): Promise<SessionInspection> { return { meta: header, events: [] } }
  async readFrom(_id: SessionId, _fromSeq: number): Promise<{ meta: SessionHeader; events: SessionEvent[] }> {
    return { meta: header, events: [] }
  }
  async list(): Promise<SessionHeader[]> { return [header] }
  async listSnapshots(): Promise<SessionPersistenceSnapshot[]> {
    return [{ header, revision: SessionPersistenceRevision('memory') }]
  }
}

const header: SessionHeader = {
  version: 0,
  id: SessionId('handle-test'),
  createdAt: 1,
}

describe('SessionPersistence explicit handles', () => {
  it('allows one write owner and releases it on close', async () => {
    const persistence = new MemoryPersistence(new Context())
    const first = persistence.openHandle(header.id, 'write')
    expect(() => persistence.openHandle(header.id, 'write')).toThrow(SessionAlreadyOwnedError)
    await first.close()
    const second = persistence.openHandle(header.id, 'write')
    await second.close()
  })

  it('rejects writes through a read handle and delegates append through a write handle', async () => {
    const persistence = new MemoryPersistence(new Context())
    const read = persistence.openHandle(header.id, 'read')
    await expect(read.append([])).rejects.toBeInstanceOf(SessionReadOnlyError)
    const write = persistence.openHandle(header.id, 'write')
    await write.append([])
    expect(persistence.appended).toEqual([[]])
    await read.close()
    await write.close()
  })

  it('makes close idempotent and refuses operations after close', async () => {
    const persistence = new MemoryPersistence(new Context())
    const handle = persistence.openHandle(header.id, 'write')
    await handle.close()
    await handle.close()
    await expect(handle.read()).rejects.toThrow(/closed/)
  })
})
