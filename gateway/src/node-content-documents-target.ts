/** Check the exact addressed composer on its owner node without starting its Runtime or returning a conversation listing. */
import type { workbenchRows } from './workbench-rows.ts'
import type { GatewayRequestContext } from './server.ts'
import { DocumentTransferError } from './document-transfer.ts'

/** Return checked coordinates for an existing writable Session or an authenticated creator-owned reservation.
 * @param read - owner-filtered directory. @param owner - authenticated selected Runtime and scope.
 * @param input - fully addressed target. @param signal - optional caller cancellation.
 * @param reservedSession - optional final reservation verifier; absent compositions admit only indexed Sessions. Existing permission errors are never retried through this verifier.
 * @returns exact writable target without starting a Runtime or reading message content.
 */
export async function checkDocumentAttachmentTarget(
  read: ReturnType<typeof workbenchRows>,
  owner: GatewayRequestContext,
  input: URLSearchParams,
  signal?: AbortSignal,
  reservedSession?: (sessionId:string)=>Promise<boolean>,
): Promise<{ runtimeId: string; sessionId: string; canWrite: true }> {
  const id = input.get('documentSession')
  const runtime = input.get('dshRuntime')
  if (
    input.getAll('documentSession').length !== 1 ||
    !id ||
    id.length > 512 ||
    /[\u0000-\u001f\u007f]/u.test(id) ||
    !runtime
  ) {
    throw new DocumentTransferError('INVALID_DOCUMENT_TRANSFER', 400, 'Invalid attachment target.')
  }
  for (const key of ['dshNode', 'dshRuntime', 'dshTarget']) {
    const values = input.getAll(key)
    if (values.length !== 1 || !values[0])
      throw new DocumentTransferError('INVALID_DOCUMENT_TRANSFER', 400, 'The attachment target must be fully addressed.')
  }
  const target = owner.scope.kind === 'personal' ? 'personal' : 'project:' + String(owner.scope.projectId)
  if (
    !owner.environment ||
    owner.environment.id !== runtime ||
    owner.environment.nodeId !== input.get('dshNode') ||
    input.get('dshTarget') !== target
  ) {
    throw new DocumentTransferError('DOCUMENT_ATTACHMENT_TARGET_UNAVAILABLE', 409, 'The selected conversation has moved.')
  }
  if (!read.exactWritableSession)
    throw new DocumentTransferError(
      'DOCUMENT_ATTACHMENT_TARGET_UNAVAILABLE',
      503,
      'The selected computer cannot verify this conversation.',
    )
  signal?.throwIfAborted()
  if (await read.exactWritableSession(owner, id) || await reservedSession?.(id) === true) {
    signal?.throwIfAborted()
    return { runtimeId: runtime, sessionId: id, canWrite: true }
  }
  throw new DocumentTransferError(
    'DOCUMENT_ATTACHMENT_TARGET_UNAVAILABLE',
    409,
    'The selected conversation is unavailable or read-only.',
  )
}
