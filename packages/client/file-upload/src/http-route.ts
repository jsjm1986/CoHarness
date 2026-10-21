/** Authenticated raw-byte upload route registered on Connection's HTTP subtree. */

import { brandString } from '@deepseek-ai/dsh-brand'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { SessionId } from '@deepseek-ai/dsh-session'
import { remoteErrorOf } from '@deepseek-ai/dsh-typert-protocol'
import type { FileUploads } from './index.ts'
import type { FileUploadValue } from './types.ts'

type FileUploadHttpResult =
  | { readonly ok: true; readonly value: FileUploadValue }
  | {
    readonly ok: false
    readonly error: { readonly code: string; readonly message: string; readonly details: object }
  }

/**
 * Handle one authenticated raw-byte upload.
 * @param service - Host upload service receiving streamed bytes.
 * @param request - authenticated HTTP request from Connection.
 * @param response - response owned by this route.
 * @returns after the JSON result is flushed.
 */
export async function handleFileUploadHttp(
  service: FileUploads,
  request: IncomingMessage,
  response: ServerResponse,
): Promise<void> {
  if (request.method !== 'POST') {
    response.writeHead(405, { allow: 'POST' })
    response.end()
    return
  }
  const rawType: unknown = request.headers['content-type']
  const headerValue: unknown = Array.isArray(rawType) ? rawType[0] : rawType
  const mediaType = typeof headerValue === 'string'
    ? headerValue.split(';', 1)[0]?.trim().toLowerCase()
    : undefined
  if (mediaType !== 'application/octet-stream') {
    response.writeHead(415, { 'content-type': 'text/plain; charset=utf-8' })
    response.end('content type must be application/octet-stream')
    return
  }
  const url = new URL(request.url ?? '/', 'http://upload.invalid')
  const sessionId = url.searchParams.get('sessionId')
  if (sessionId === null || sessionId === '') {
    response.writeHead(400, { 'content-type': 'text/plain; charset=utf-8' })
    response.end('sessionId is required')
    return
  }
  const name = url.searchParams.get('name') ?? undefined
  const aborted = new AbortController()
  const onAborted = (): void => { aborted.abort(new Error('upload request aborted')) }
  request.once('aborted', onAborted)
  let result: FileUploadHttpResult
  try {
    result = {
      ok: true,
      value: await service.uploadStream({
        sessionId: brandString<SessionId>(sessionId),
        data: request,
        signal: aborted.signal,
        ...(name === undefined ? {} : { name }),
      }),
    }
  } catch (error) {
    const failure = remoteErrorOf(error)
    result = {
      ok: false,
      error: failure !== undefined
        ? { code: failure.code, message: failure.message, details: failure.details }
        : {
          code: 'gateway/internal',
          message: error instanceof Error ? error.message : String(error),
          details: {},
        },
    }
  } finally {
    request.off('aborted', onAborted)
  }
  response.writeHead(200, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  })
  response.end(JSON.stringify(result))
}
