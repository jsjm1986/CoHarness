/** Check the exact addressed composer on its owner node without starting its Runtime or returning a conversation listing. */
import type { workbenchRows } from './workbench-rows.ts'
import type { GatewayRequestContext } from './server.ts'
import { DocumentTransferError } from './document-transfer.ts'

/** Return only the checked coordinates after the existing owner-filtered directory confirms writable access. */
export async function checkDocumentAttachmentTarget(
  read: ReturnType<typeof workbenchRows>,
  owner: GatewayRequestContext,
  input: URLSearchParams,
  signal?: AbortSignal,
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
  if (await read.exactWritableSession(owner, id)) {
    signal?.throwIfAborted()
    return { runtimeId: runtime, sessionId: id, canWrite: true }
  }
  throw new DocumentTransferError(
    'DOCUMENT_ATTACHMENT_TARGET_UNAVAILABLE',
    409,
    'The selected conversation is unavailable or read-only.',
  )
}
