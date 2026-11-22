import { EventEmitter } from 'node:events'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { PassThrough } from 'node:stream'
import { describe, expect, it, vi } from 'vitest'
import type { GatewayModelGovernanceService } from '../src/services.ts'
import { createUsageIntakeServer } from '../src/usage-intake.ts'

class FakeResponse extends EventEmitter {
  statusCode = 200
  headers: Record<string, string> = {}
  body = ''
  writableEnded = false
  reqDestroyedAtEnd: boolean | undefined

  constructor(private readonly req: PassThrough) {
    super()
  }

  writeHead(status: number, headers: Record<string, string> = {}): this {
    this.statusCode = status
    for (const [key, value] of Object.entries(headers)) this.headers[key.toLowerCase()] = value
    return this
  }

  end(chunk = ''): this {
    this.reqDestroyedAtEnd = this.req.destroyed
    this.body += chunk
    this.writableEnded = true
    this.emit('finish')
    return this
  }
}

function fakeGovernance(): GatewayModelGovernanceService {
  return {
    subjectForIntakeToken: vi.fn(async (token: string) => token === 'valid-token' ? { kind: 'user' as const, id: 1 } : null),
    ingest: vi.fn(async () => ({ inserted: true })),
    ingestRegistration: vi.fn(async () => ({ inserted: true })),
  } as unknown as GatewayModelGovernanceService
}

describe('createUsageIntakeServer oversized body handling', () => {
  it('returns HTTP 400 without destroying the request stream before flushing the response', async () => {
    const governance = fakeGovernance()
    const server = createUsageIntakeServer(governance)
    const req = new PassThrough() as PassThrough & {
      method?: string
      url?: string
      headers: Record<string, string>
      complete: boolean
    }
    req.method = 'POST'
    req.url = '/usage'
    req.headers = { authorization: 'Bearer valid-token', 'content-type': 'application/json' }
    req.complete = false
    const res = new FakeResponse(req)
    const finished = new Promise<void>(resolve => res.once('finish', resolve))

    server.emit('request', req as unknown as IncomingMessage, res as unknown as ServerResponse)
    req.write(Buffer.alloc(200 * 1024, 0x61))
    req.write(Buffer.alloc(100 * 1024, 0x62))
    await finished

    expect(res.statusCode).toBe(400)
    expect(JSON.parse(res.body)).toEqual({ error: 'body too large' })
    expect(res.headers.connection).toBe('close')
    expect(res.reqDestroyedAtEnd).toBe(false)
    expect(governance.ingest).not.toHaveBeenCalled()
  })

  it('rejects an oversized declared content-length with HTTP 400 and closes the connection', async () => {
    const governance = fakeGovernance()
    const server = createUsageIntakeServer(governance)
    const req = new PassThrough() as PassThrough & {
      method?: string
      url?: string
      headers: Record<string, string>
      complete: boolean
    }
    req.method = 'POST'
    req.url = '/usage'
    req.headers = {
      authorization: 'Bearer valid-token',
      'content-type': 'application/json',
      'content-length': String(300 * 1024),
    }
    req.complete = false
    const res = new FakeResponse(req)
    const finished = new Promise<void>(resolve => res.once('finish', resolve))

    server.emit('request', req as unknown as IncomingMessage, res as unknown as ServerResponse)
    await finished

    expect(res.statusCode).toBe(400)
    expect(JSON.parse(res.body)).toEqual({ error: 'body too large' })
    expect(res.headers.connection).toBe('close')
    expect(res.reqDestroyedAtEnd).toBe(false)
    expect(governance.ingest).not.toHaveBeenCalled()
  })
})
