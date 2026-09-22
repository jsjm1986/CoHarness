import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it } from 'vitest'
import { SESSION_FORMAT_VERSION, SessionId, SessionLogOffset, type SessionEvent, type SessionHeader } from '@deepseek-ai/dsh-session'
import SessionPersistence, {
  SessionAlreadyOwnedError,
  SessionPersistenceRevision,
  SessionReadOnlyError,
  type SessionEventSuffix, type SessionInspection,
  type SessionLocation,
  type SessionPersistenceSnapshot,
} from '../src/index.ts'

class MemoryPersistence extends SessionPersistence {
  override readonly supportsRawArtifacts = false
  readonly appended: SessionEvent[][] = []

  override locate(_meta: SessionHeader): SessionLocation | undefined { return undefined }
  override async createStored(_meta: SessionHeader): Promise<void> {}
  override async materializeDetached(_id: SessionId): Promise<void> {}
  override async discardDetached(_id: SessionId): Promise<void> {}
  override listPending(): readonly import('../src/index.ts').SessionStorageMetadata[] { return [] }
  override async append(_id: SessionId, events: readonly SessionEvent[]): Promise<void> { this.appended.push([...events]) }
  override async load(_id: SessionId): Promise<SessionInspection> {
    return { meta: header, inheritedEventCount: SessionLogOffset(0), events: [] }
  }
  override async inspect(_id: SessionId): Promise<SessionInspection> {
    return { meta: header, inheritedEventCount: SessionLogOffset(0), events: [] }
  }
  override async readFrom(_id: SessionId, fromSeq: SessionLogOffset): Promise<SessionEventSuffix> {
    return { meta: header, inheritedEventCount: SessionLogOffset(0), fromSeq, events: [] }
  }
  override async listStored(): Promise<SessionHeader[]> { return [header] }
  override async listSnapshots(): Promise<SessionPersistenceSnapshot[]> {
    return [{ header, revision: SessionPersistenceRevision('memory') }]
  }
}

const header: SessionHeader = {
  version: SESSION_FORMAT_VERSION,
  id: SessionId('handle-test'),
  createdAt: 1,
  isSeeded: false,
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
