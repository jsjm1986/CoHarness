/** Resolve document RPC authority from the authenticated runtime and its durable execution registry. */
import type { IncomingMessage, ServerResponse } from 'node:http'
import { GATEWAY_DOCUMENT_STORE_PATH, type DocumentStoreRequest } from '@deepseek-ai/dsh-userdoc-gateway/protocol'
import { DOCUMENT_PERMISSION_DENIED_CODE, DOCUMENT_STORE_UNAVAILABLE_CODE, DOCUMENT_TRANSPORT_PROTOCOL_CODE, UserDocError } from '@deepseek-ai/dsh-userdoc'
import { assertNever } from '@deepseek-ai/dsh-util-values'
import { CollaborationDeniedError } from './collaboration.ts'
import { ExecutionIdentityError, type ExecutionIdentityState, type GatewayExecutionIdentity } from './execution-identity.ts'
import type { GatewayPrincipalClaims } from './principal.ts'
import type { RuntimeCredentialSubject } from './runtime-api.ts'
import type { GatewayRuntimeHandler } from './server.ts'
import type { WriteGateVerdict } from './postgres/maintenance-service.ts'
import type { GatewayAccessMonitor } from './access-invalidation.ts'

/** Runtime descriptors carry no user authority; execution participants come exclusively from durable receipts. */
export type RuntimeDocumentStoreAuthority =
  | { readonly kind: 'runtime' }
  | { readonly kind: 'request'; readonly principal: GatewayPrincipalClaims }
  | { readonly kind: 'execution'; readonly state: ExecutionIdentityState }

/** One authenticated stream retained by the backend owner through parsing, authorization and response cleanup. */
export interface RuntimeDocumentStoreInvocation {
  readonly request: IncomingMessage
  readonly response: ServerResponse
  readonly subject: RuntimeCredentialSubject
  /** Live document-transfer revocation; the backend retains it through response and source cleanup. */
  readonly signal: AbortSignal
  /** Check before mutations; retain the response's maintenance writer span. */
  readonly writeGate: () => Promise<WriteGateVerdict>
  /**
   * Resolve a parser-validated envelope without borrowing an interactive assertion for captured execution.
   * @param envelope - exact document RPC and its explicit authority selection.
   * @param signal - cancellation while queued or checking current eligibility.
   * @returns descriptor authority, a verified principal, or the complete current execution participant set.
   */
  authorize(envelope: DocumentStoreRequest, signal: AbortSignal): Promise<RuntimeDocumentStoreAuthority>
}

/** Backend owner responsible for admission, physical roots, ownership checks and catalog acknowledgement. */
export interface RuntimeDocumentStoreHandler {
  /**
   * @param invocation - authenticated stream and its independently resolved operation authority.
   * @returns after response delivery and owned input cleanup settle.
   */
  (invocation: RuntimeDocumentStoreInvocation): Promise<void>
}

/** Runtime API services used before selecting any document backend. */
export interface RuntimeDocumentStoreStreamDependencies {
  readonly execution: Pick<GatewayExecutionIdentity, 'authorize'>
  readonly serve: RuntimeDocumentStoreHandler
  readonly accessMonitor: GatewayAccessMonitor
  /**
   * @param request - runtime request whose bearer credential must name a current generation.
   * @returns the live runtime subject, or null; cleanup credentials grant no document access.
   */
  authenticate(request: IncomingMessage): Promise<RuntimeCredentialSubject | null>
  /**
   * @param request - request carrying the signed interactive principal.
   * @param subject - exact runtime already authenticated independently.
   * @param allowDocumentAdmin - whether this document lifecycle method accepts administrator purpose.
   * @returns verified claims for this runtime; every verification failure refuses the operation.
   */
  principal(request: IncomingMessage, subject: RuntimeCredentialSubject, allowDocumentAdmin: boolean): GatewayPrincipalClaims | Promise<GatewayPrincipalClaims>
}

/**
 * Register the document endpoint ahead of buffered runtime control bodies.
 * @param deps - current-token verifier, signed-principal verifier, execution registry and backend owner.
 * @returns a stream handler that leaves unrelated request bodies untouched.
 */
export function createRuntimeDocumentStoreStream(
  deps: RuntimeDocumentStoreStreamDependencies,
): NonNullable<GatewayRuntimeHandler['stream']> {
  return async (request, response, pathname, writeGate) => {
    if (pathname !== GATEWAY_DOCUMENT_STORE_PATH) return false
    const subject = await deps.authenticate(request)
    if (subject === null) {
      request.resume()
      response.writeHead(401, { 'content-type': 'application/json', 'connection': 'close' })
      response.end(JSON.stringify({ error: 'invalid-runtime-token' }))
      return true
    }
    const abort = new AbortController()
    type Completion = { readonly ok: true } | { readonly ok: false; readonly error: unknown }
    let settle!: (result: Completion) => void
    const completion = new Promise<Completion>((resolve) => { settle = resolve })
    let admitted = false, checkingAuthority = false, watchingTransfer = false, failed = false, failure: unknown
    let actors: ReadonlySet<number> | undefined
    const unsubscribe = deps.accessMonitor.subscribe(async (changed) => {
      if (changed.projectId !== undefined && (subject.target.kind !== 'project' || changed.projectId !== subject.target.id)) return
      if (changed.userId !== undefined && actors !== undefined && !actors.has(changed.userId)
        && (subject.target.kind !== 'user' || changed.userId !== subject.target.id)) return
      const available = deps.accessMonitor.available
      if (available && (!(admitted || checkingAuthority) || !watchingTransfer)) return
      abort.abort(new UserDocError(available ? 'Document access was revoked.' : 'Document access monitoring is unavailable.',
        available ? DOCUMENT_PERMISSION_DENIED_CODE : DOCUMENT_STORE_UNAVAILABLE_CODE))
      if (admitted && watchingTransfer) {
        const result = await completion
        if (!result.ok) throw result.error
      }
    })
    try {
      await deps.serve({ request, response, subject, writeGate, signal: abort.signal,
        async authorize(envelope, requestSignal) {
          const signal = AbortSignal.any([requestSignal, abort.signal])
          signal.throwIfAborted()
          try {
            try { await deps.accessMonitor.synchronize() } catch (cause) {
              signal.throwIfAborted()
              throw new UserDocError('Document access monitoring is unavailable.', DOCUMENT_STORE_UNAVAILABLE_CODE, { cause })
            }
            signal.throwIfAborted()
            if (!deps.accessMonitor.available) throw new UserDocError('Document access monitoring is unavailable.', DOCUMENT_STORE_UNAVAILABLE_CODE)
            watchingTransfer = envelope.operation.kind === 'openRead' || envelope.operation.kind === 'save'
              || envelope.operation.kind === 'writeUploadChunk'
            checkingAuthority = true
            let authority: RuntimeDocumentStoreAuthority
            switch (envelope.authority.kind) {
              case 'runtime': {
                if (envelope.operation.kind !== 'describe') throw new CollaborationDeniedError('forbidden')
                authority = { kind: 'runtime' }
                actors = new Set()
                break
              }
              case 'request': {
                const kind = envelope.operation.kind
                let principal: GatewayPrincipalClaims
                try {
                  principal = await deps.principal(request, subject, kind === 'trash' || kind === 'restore' || kind === 'purge')
                } catch (error) {
                  throw new UserDocError('Document access is no longer permitted.', DOCUMENT_PERMISSION_DENIED_CODE, { cause: error })
                }
                signal.throwIfAborted()
                authority = { kind: 'request', principal }
                actors = new Set([principal.user.id])
                break
              }
              case 'execution': {
                const state = await deps.execution.authorize(subject, { sessionId: envelope.authority.sessionId,
                  scopeId: envelope.authority.scopeId, capability: 'execute' })
                signal.throwIfAborted()
                authority = { kind: 'execution', state }
                actors = new Set(state.actors.map(actor => actor.userId))
                break
              }
              /* v8 ignore next -- the document parser closes authority tags before this typed dispatcher. */
              default: return assertNever(envelope.authority)
            }
            const current = await deps.authenticate(request)
            if (current === null || current.organizationId !== subject.organizationId || current.generation !== subject.generation
              || current.target.kind !== subject.target.kind || current.target.id !== subject.target.id) {
              throw new UserDocError('Document access is no longer permitted.', DOCUMENT_PERMISSION_DENIED_CODE)
            }
            signal.throwIfAborted()
            admitted = true
            return authority
          } catch (error) {
            signal.throwIfAborted()
            if (error instanceof CollaborationDeniedError
              || error instanceof ExecutionIdentityError && (error.status === 403 || error.status === 404)) {
              throw new UserDocError('Document access is no longer permitted.', DOCUMENT_PERMISSION_DENIED_CODE, { cause: error })
            }
            if (error instanceof ExecutionIdentityError && error.status === 400) {
              throw new UserDocError('Document authority metadata is invalid.', DOCUMENT_TRANSPORT_PROTOCOL_CODE, { cause: error })
            }
            throw error
          } finally { checkingAuthority = false }
        },
      })
    } catch (error) { failed = true; failure = error; throw error }
    finally { unsubscribe(); settle(failed ? { ok: false, error: failure } : { ok: true }) }
    return true
  }
}
