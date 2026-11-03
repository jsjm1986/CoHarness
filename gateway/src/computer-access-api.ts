/** Central computer permissions, available independently of the target computer's connection. */
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { UserRow } from './auth.ts'
import { ComputerAccessError, type GatewayComputerAccess } from './computer-access.ts'

/**
 * Handle the organization-owned computer-permission API before node forwarding.
 * @param service - current organization permission owner.
 * @param req - authenticated, origin-checked browser request.
 * @param res - uncached JSON response.
 * @param actor - current browser account; authority is rechecked by the service.
 * @param readBody - existing bounded Gateway request reader.
 * @returns true for a handled computer-permission endpoint.
 */
export async function computerAccessApi(service: GatewayComputerAccess | undefined, req: IncomingMessage,
  res: ServerResponse, actor: UserRow, readBody: () => Promise<string>): Promise<boolean> {
  const url = new URL(req.url ?? '/', 'http://gateway')
  const admin = /^\/admin\/api\/users\/([1-9][0-9]*)\/computers(?:\/([^/]+))?$/u.exec(url.pathname)
  if (admin === null && url.pathname !== '/account/api/computers') return false
  res.setHeader('cache-control', 'no-store')
  const send = (status: number, value: unknown): void => {
    res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(value))
  }
  try {
    if (service === undefined) throw new ComputerAccessError(503, 'computer-access/unavailable')
    if (admin !== null && actor.role !== 'admin') throw new ComputerAccessError(403, 'computer-access/forbidden')
    const userId = admin === null ? undefined : Number(admin[1])
    if (req.method === 'GET' && admin?.[2] === undefined) {
      const cursor = url.searchParams.get('cursor'), limit = url.searchParams.get('limit')
      send(200, await service.page(actor, { ...(cursor === null ? {} : { cursor }), ...(limit === null ? {} : { limit }) }, userId))
    } else if (req.method === 'PUT' && admin?.[2] !== undefined) {
      let value: unknown
      try { value = JSON.parse(await readBody()) }
      catch (error) { if (!(error instanceof SyntaxError)) throw error; throw new ComputerAccessError(400, 'computer-access/invalid-request') }
      send(200, await service.set(actor, userId!, admin[2], value))
    } else {
      res.setHeader('allow', admin?.[2] === undefined ? 'GET' : 'PUT')
      send(405, { error: 'method-not-allowed' })
    }
  } catch (error) {
    if (!(error instanceof ComputerAccessError)) throw error
    send(error.status, { error: error.code })
  }
  return true
}
