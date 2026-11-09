/** Request-owned administrator qualification immediately before a JSON read response is published. */
import { CollaborationDeniedError } from './collaboration.ts'
import type { GatewayUserService } from './services.ts'

/** Failure to establish current administrator authority; no selected response data is published. */
export class AdministratorReadUnavailableError extends Error {
  /** @param cause - failure of the current account lookup, retained for operator diagnostics. */
  constructor(cause: unknown) {
    super('Current administrator authority is unavailable. Reload the current state before trying again.', { cause })
    this.name = 'AdministratorReadUnavailableError'
  }
}

/** Headers published with authorized JSON data, never with an authority refusal. */
export type AdministratorResponseHeaders = Readonly<Record<string, string>>

/** One already-selected JSON response's synchronous transport writer. */
export type AdministratorJsonWriter = (status: number, body: unknown, headers?: AdministratorResponseHeaders) => void

/** Awaited responses keep current read qualification ahead of both data and metadata headers. */
export interface AdministratorResponse {
  /**
   * Publish selected data after current read authority is confirmed.
   * @param status - HTTP response status.
   * @param body - selected JSON data.
   * @param headers - data-specific response headers, published only after authorization.
   * @returns after the authorized response is handed to the transport.
   */
  json(status: number, body: unknown, headers?: AdministratorResponseHeaders): Promise<void>
  /**
   * Publish a read result with current qualification, including diagnostics transported by POST.
   * @param status - HTTP response status.
   * @param body - prepared read result.
   * @param headers - data-specific headers, withheld until authorization succeeds.
   * @returns after the currently authorized response is handed to the transport.
   */
  readJson(status: number, body: unknown, headers?: AdministratorResponseHeaders): Promise<void>
  /**
   * Publish a selected endpoint error under the same read qualification.
   * @param status - endpoint failure status.
   * @param error - public error description.
   * @param code - optional stable error identifier.
   * @returns after the authorized endpoint error is handed to the transport.
   */
  error(status: number, error: string, code?: string): Promise<void>
}

/**
 * Bind one HTTP request's response to its authenticated administrator and current effective account.
 * GET, HEAD and explicit read results recheck after asynchronous preparation; lookup failures refuse publication.
 * Mutation admission remains with the owning service, so a committed mutation keeps its success response.
 * @param users - account lookup whose effective status includes organization and membership eligibility.
 * @param actorUserId - server-authenticated administrator identifier.
 * @param method - incoming HTTP method.
 * @param write - synchronous JSON transport writer; called only after required authorization.
 * @returns responders owned by this one request, with no reusable authorization cache.
 */
export function createAdministratorResponse(
  users: Pick<GatewayUserService, 'getById'>,
  actorUserId: number,
  method: string,
  write: AdministratorJsonWriter,
): AdministratorResponse {
  const isRead = method === 'GET' || method === 'HEAD'
  const readJson: AdministratorResponse['readJson'] = async (status, body, headers) => {
    let current: Awaited<ReturnType<GatewayUserService['getById']>>
    try { current = await users.getById(actorUserId) }
    catch (cause) { throw new AdministratorReadUnavailableError(cause) }
    if (current === null || current.status !== 'active' || current.role !== 'admin' || current.mustChangePassword) {
      throw new CollaborationDeniedError('forbidden')
    }
    write(status, body, headers)
  }
  const json: AdministratorResponse['json'] = async (status, body, headers) => {
    if (isRead) await readJson(status, body, headers)
    else write(status, body, headers)
  }
  return { json, readJson, error: (status, error, code) => json(status, { error, ...(code === undefined ? {} : { code }) }) }
}
