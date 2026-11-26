import { IncomingMessage, ServerResponse } from 'node:http'
import { Socket } from 'node:net'
import { describe, expect, it, vi } from 'vitest'
import { createUsageIntakeServer } from '../src/usage-intake.ts'
import { deferred } from './barrier.ts'

function fakeGovernance() {
  return {
    subjectForIntakeToken: vi.fn(async (token: string) => token === 'valid-token' ? { kind: 'user' as const, id: 1 } : null),
    ingest: vi.fn(async () => ({ inserted: true, alerts: 0 })),
    ingestRegistration: vi.fn(async () => ({ inserted: true })),
  }
}

function invokeUsage(governance: ReturnType<typeof fakeGovernance>, contentLength?: number) {
  const server = createUsageIntakeServer(governance)
  const request = new IncomingMessage(new Socket())
  request.method = 'POST'
  request.url = '/usage'
  request.headers = { authorization: 'Bearer valid-token', 'content-type': 'application/json' }
  if (contentLength !== undefined) request.headers['content-length'] = String(contentLength)
  const response = new ServerResponse(request)
  const writeHead = vi.spyOn(response, 'writeHead')
  const completed = deferred<{ body: unknown; requestDestroyed: boolean }>()
  vi.spyOn(response, 'end').mockImplementation((body?: unknown) => {
    completed.resolve({ body, requestDestroyed: request.destroyed })
    return response
  })
  server.emit('request', request, response)
  return { request, response, writeHead, completed: completed.promise }
}

describe('createUsageIntakeServer oversized body handling', () => {
  it('returns HTTP 400 without destroying the request stream before flushing the response', async () => {
    const governance = fakeGovernance()
    const { request, response, writeHead, completed } = invokeUsage(governance)
    request.push(Buffer.alloc(200 * 1024, 0x61))
    request.push(Buffer.alloc(100 * 1024, 0x62))
    expect(await completed).toEqual({ body: JSON.stringify({ error: 'body too large' }), requestDestroyed: false })
    expect(response.statusCode).toBe(400)
    expect(writeHead).toHaveBeenCalledWith(400, expect.objectContaining({ connection: 'close' }))
    expect(governance.ingest).not.toHaveBeenCalled()
    request.push(null)
  })

  it('rejects an oversized declared content-length with HTTP 400 and closes the connection', async () => {
    const governance = fakeGovernance()
    const { request, response, writeHead, completed } = invokeUsage(governance, 300 * 1024)
    expect(await completed).toEqual({ body: JSON.stringify({ error: 'body too large' }), requestDestroyed: false })
    expect(response.statusCode).toBe(400)
    expect(writeHead).toHaveBeenCalledWith(400, expect.objectContaining({ connection: 'close' }))
    expect(governance.ingest).not.toHaveBeenCalled()
    request.push(null)
  })
})
