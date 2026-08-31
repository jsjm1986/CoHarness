/**
 * Scope-addressed conversation send, cancel, and history orchestration.
 *
 * Scope addressing rides the cordis Service tracker: property access through
 * `ctx.conversation` rebinds `this.ctx` to the caller's context, so methods
 * read the session tag with `scopeOf`. Mutable state must remain reachable
 * through one property read; assignment through the tracker proxy and `#`
 * private fields bypass that rebinding.
 */
import { Service } from '@deepseek-ai/cordis'
import type { Context } from '@deepseek-ai/cordis'
import { bytesToBase64, randomUUID } from '@deepseek-ai/dsh-util-crypto'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-runtime/client'
import type { SnapshotStore } from '@deepseek-ai/dsh-client-runtime/client'
// Type-only imports: a plugin-to-plugin value import is a bundle purity
// error, so scope resolution goes through the sessions service (scopeOf
// method) instead of the standalone helper.
import type {
  ISessions, PendingSubmissionRetirement, SessionFace, SessionId,
} from '@deepseek-ai/dsh-client-runtime/client'
import type { SubmitImageAttachment, SubmitOutcome } from '@deepseek-ai/dsh-client-ui-input-trigger/client'
import type { ImageAttachmentRef, ImageMediaType } from '@deepseek-ai/dsh-attachment'
import type { UserDocIdType, UserDocRef } from '@deepseek-ai/dsh-userdoc'
import type { ComposerAttachment, ComposerDocument } from './contract/slots.ts'
import type { QueueAction, QueueItemId } from './contract/queue.ts'
import type { ComposerBlocks } from './input/blocks.ts'
import type { DraftAttachmentId, DraftDocumentId, SessionInputResolver } from './input/contract.ts'
import type { InputSubmitMode } from './contract/composer-submission.ts'
import { createUserDocClient, UserDocHttpError, UserDocServiceUnavailableError } from './userdoc-client.ts'

/**
 * The outward conversation face (`ctx.conversation`): the scope-addressed
 * verbs and the input registry other plugins may reach — and exactly what a
 * test fake must supply.
 */
export interface IConversation {
  /** The per-session input machine registry (SessionInputResolver face). */
  readonly input: SessionInputResolver
  /**
   * The per-session composer-block registry: how a plugin the composer
   * cannot import makes a session's input inert with its own reason.
   */
  readonly blocks: ComposerBlocks
  /**
   * Send a prompt into the caller scope's session (queued turn).
   * @param text - prompt text, sent verbatim as one text block.
   * @returns completion; business failures reject (and land in promptError).
   */
  send(text: string): Promise<void>
  /**
   * Apply one edit, remove, or strict steer operation to a pending queue occurrence.
   * @param itemId - agent-owned inbox occurrence identity.
   * @param action - requested queue operation.
   * @returns completion; converged strict-steer races resolve, while other failures reject.
   */
  updateQueue(itemId: QueueItemId, action: QueueAction): Promise<void>
  /**
   * Cancel the scoped session's in-flight turn while preserving its pending Queue.
   * @returns completion; failures reject as in send.
   */
  cancel(): Promise<void>
  /**
   * Pull one older history page for the scoped session.
   * @returns completion of the page pull.
   */
  loadOlder(): Promise<void>
  /**
   * Attach one already-stored user document to a session's composer without
   * uploading a second copy.
   * @param sessionId - target session id.
   * @param ref - durable document reference returned by the user-document service.
   * @returns true when the composer accepted the document; false when the
   * session is unavailable or its input is in a locked submission phase.
   */
  attachDocument(sessionId: SessionId, ref: UserDocRef): boolean
}

/** Create one browser-only draft descriptor; only its id enters input state. */
function browserDraftAttachment(file: File): ComposerAttachment {
  return {
    kind: 'image',
    id: randomUUID() as DraftAttachmentId,
    previewUrl: URL.createObjectURL(file),
    file,
  }
}

interface ImageUrlEntry {
  readonly sessionId: SessionId
  readonly generation: number
  readonly pending: Promise<string>
  readonly current?: string
}

interface DraftDocumentEntry {
  readonly sessionId: SessionId
  readonly file?: File
  readonly controller: AbortController
  readonly ownsUploadedFile: boolean
  descriptor: ComposerDocument
}

interface ReadyComposerDocument extends ComposerDocument {
  readonly docId: UserDocIdType
  readonly status: 'ready'
}

/** Unsupported browser-declared image type, localized by the UI boundary. */
export class UnsupportedImageMediaTypeError extends Error {
  /** Browser-declared MIME value, possibly empty. */
  readonly mediaType: string

  /** @param mediaType - Browser-declared MIME value, possibly empty. */
  constructor(mediaType: string) {
    super(`unsupported image media type: ${mediaType || '(empty)'}`)
    this.name = 'UnsupportedImageMediaTypeError'
    this.mediaType = mediaType
  }
}

/** Scope-addressed conversation service (root singleton, provided as `conversation`). */
export class ConversationController extends Service implements IConversation {
  /** The per-session input machine registry (SessionInputResolver face). */
  readonly input: SessionInputResolver
  /** The per-session composer-block registry. */
  readonly blocks: ComposerBlocks
  private readonly draftAttachments = new Map<DraftAttachmentId, ComposerAttachment>()
  private readonly draftDocuments = new Map<DraftDocumentId, DraftDocumentEntry>()
  private readonly documentStores = new Map<SessionId, SnapshotStore<readonly ComposerDocument[]>>()
  private readonly userDocs = createUserDocClient()
  private readonly imageUrls = new Map<string, ImageUrlEntry>()
  private readonly imageGenerations = new Map<SessionId, number>()
  private readonly createdImageUrls = new Set<string>()
  private disposed = false

  /**
   * @param ctx - owning root context (the plugin apply context; the service
   * registers itself and follows that fiber's lifetime).
   * @param config - carries the SessionInputResolver and composer-block registry
   * constructed by the plugin apply (the same instances the slot inject
   * factories close over).
   */
  constructor(ctx: Context, config: { input: SessionInputResolver; blocks: ComposerBlocks }) {
    super(ctx, 'conversation')
    this.input = config.input
    this.blocks = config.blocks
    ctx.effect(() => () => {
      this.disposed = true
      for (const url of this.createdImageUrls) revokePreview(url)
      this.createdImageUrls.clear()
      this.draftAttachments.clear()
      for (const entry of this.draftDocuments.values()) entry.controller.abort()
      this.draftDocuments.clear()
      this.documentStores.clear()
      this.imageUrls.clear()
      this.imageGenerations.clear()
    }, 'conversation attachment URL cache')
  }

  /**
   * Send a prompt into the scoped session. Business failures also land in the
   * session snapshot's promptError (object-layer state); the rejection here
   * exists for caller choreography (the composer restores the draft on it).
   * @param text - prompt text, sent verbatim as one text block.
   */
  async send(text: string): Promise<void> {
    const session = this.scopedSession('send')
    const result = await session.prompt([{ type: 'text', text }], 'queue')
    if (!result.ok) throw new Error(`conversation.send failed: ${result.error.code}: ${result.error.message}`)
  }

  /**
   * Submit ordered draft images with text through one host admission.
   * @param session - target session.
   * @param text - serialized prompt text.
   * @param imageIds - ordered draft-local attachment ids.
   * @param documentIds - ordered draft-local document ids.
   * @param mode - queue or steer delivery selected by composer policy.
   * @param signal - optional cancellation for the complete Host admission.
   * @returns the Host admission outcome; local attachment preparation failures reject.
   */
  async sendSession(
    session: SessionFace,
    text: string,
    imageIds: readonly DraftAttachmentId[],
    documentIds: readonly DraftDocumentId[],
    mode: InputSubmitMode,
    signal?: AbortSignal,
  ): Promise<SubmitOutcome> {
    const attachments = this.draftImages(imageIds)
    if (attachments.length !== imageIds.length) {
      throw new Error('conversation.sendSession: one or more draft images are no longer available')
    }
    const documents = this.draftDocumentsFor(session.sessionId, documentIds)
    if (documents.length !== documentIds.length) {
      throw new Error('conversation.sendSession: one or more draft documents are no longer available')
    }
    // Session-backed subagents and legacy structural fakes do not expose the
    // local echo seam; preserve their existing serialize→prompt choreography.
    if (session.getSnapshot().subagent !== null || session.beginSubmission === undefined) {
      const uploaded = await this.serializeImages(attachments.map(attachment => attachment.file), signal)
      const content = [
        ...uploaded,
        ...documents.map(document => ({ type: 'document' as const, docId: document.docId })),
        ...(text === '' ? [] : [{ type: 'text' as const, text }]),
      ]
      const result = await session.prompt(content, mode, signal)
      if (!result.ok) return { kind: 'error' }
      this.releaseDraftImages(attachments)
      this.releaseDraftDocuments(session.sessionId, documentIds)
      return { kind: 'success' }
    }

    let finishRetirement: ((retirement: PendingSubmissionRetirement) => void) | undefined
    const retirement = attachments.length === 0
      ? undefined
      : new Promise<PendingSubmissionRetirement>((resolve) => {
        finishRetirement = resolve
      })
    const submission = session.beginSubmission({
      text,
      images: attachments.map(attachment => ({
        previewUrl: attachment.previewUrl,
        ...(attachment.file.name === '' ? {} : { name: attachment.file.name }),
      })),
      onRetire: (settlement) => {
        this.settleSubmittedImages(session.sessionId, attachments, settlement)
        finishRetirement?.(settlement)
      },
    })
    let content: Parameters<SessionFace['prompt']>[0]
    try {
      // Give React a chance to paint the local echo before expensive encoding.
      await nextPaint()
      const uploaded = await this.serializeImages(attachments.map(attachment => attachment.file))
      content = [
        ...uploaded,
        ...documents.map(document => ({ type: 'document' as const, docId: document.docId })),
        ...(text === '' ? [] : [{ type: 'text' as const, text }]),
      ]
    } catch (error) {
      submission.abandon()
      throw error
    }
    const result = await session.prompt(content, mode, signal, submission.requestId)
    if (!result.ok) return { kind: 'error' }
    this.releaseDraftDocuments(session.sessionId, documentIds)
    if (retirement !== undefined && (await retirement).reason !== 'observed') return { kind: 'error' }
    return { kind: 'success' }
  }

  /**
   * Create runtime-only draft images and their object URLs.
   * @param files - browser files to register after MIME validation.
   * @returns ordered draft descriptors.
   */
  createDraftImages(files: readonly File[]): readonly ComposerAttachment[] {
    for (const file of files) imageMediaType(file.type)
    return files.map((file) => {
      const attachment = browserDraftAttachment(file)
      this.draftAttachments.set(attachment.id, attachment)
      this.createdImageUrls.add(attachment.previewUrl)
      return attachment
    })
  }

  /**
   * Resolve ordered input-state ids to runtime-owned draft images.
   * @param ids - draft attachment ids.
   * @returns descriptors that remain live, in requested order.
   */
  draftImages(ids: readonly DraftAttachmentId[]): readonly ComposerAttachment[] {
    const attachments: ComposerAttachment[] = []
    for (const id of ids) {
      const attachment = this.draftAttachments.get(id)
      if (attachment !== undefined) attachments.push(attachment)
    }
    return attachments
  }

  /**
   * Serialize ordered draft images to command-submit wire payloads without
   * sending or releasing them (the composer releases only after the command
   * settles successfully).
   * @param imageIds - ordered draft-local attachment ids.
   * @param signal - optional cancellation checked around each file read.
   * @returns base64 payloads in id order.
   */
  async serializeDraftImages(
    imageIds: readonly DraftAttachmentId[],
    signal?: AbortSignal,
  ): Promise<readonly SubmitImageAttachment[]> {
    signal?.throwIfAborted()
    const attachments = this.draftImages(imageIds)
    if (attachments.length !== imageIds.length) {
      throw new Error('conversation.serializeDraftImages: one or more draft images are no longer available')
    }
    return Promise.all(attachments.map(attachment => this.encodeImage(attachment.file, signal)))
  }

  /**
   * Release one browser-owned draft image and preview URL.
   * @param id - draft attachment id.
   */
  releaseDraftImage(id: DraftAttachmentId): void {
    const attachment = this.draftAttachments.get(id)
    if (attachment === undefined) return
    this.draftAttachments.delete(id)
    this.createdImageUrls.delete(attachment.previewUrl)
    revokePreview(attachment.previewUrl)
  }

  /**
   * Release a set of browser-owned draft images.
   * @param attachments - descriptors to release.
   */
  releaseDraftImages(attachments: readonly ComposerAttachment[]): void {
    for (const attachment of attachments) this.releaseDraftImage(attachment.id)
  }

  /**
   * Return the live per-session document projection used by the composer hook.
   * @param sessionId - session whose browser drafts are projected.
   * @returns snapshot store containing the current document descriptors.
   */
  documentStore(sessionId: SessionId): SnapshotStore<readonly ComposerDocument[]> {
    const existing = this.documentStores.get(sessionId)
    if (existing !== undefined) return existing
    const store = createSnapshotStore<readonly ComposerDocument[]>(this.documentsFor(sessionId))
    this.documentStores.set(sessionId, store)
    return store
  }

  /**
   * Attach one durable document to a session's composer as a ready draft.
   * Existing durable files are referenced by id and are never owned by the
   * browser draft lifecycle, so removing the composer chip cannot delete them.
   * @param sessionId - target session id.
   * @param ref - durable document reference from the manager or user-document service.
   * @returns true when the composer accepted the document.
   */
  attachDocument(sessionId: SessionId, ref: UserDocRef): boolean {
    if (this.disposed) return false
    const sessions = this.ctx.get('sessions')
    if (sessions === undefined) return false
    const actx = sessions.scope(sessionId)
    if (actx === undefined) return false
    const shell = this.input.for(actx)
    const existing = [...this.draftDocuments.values()].find(entry =>
      entry.sessionId === sessionId && entry.descriptor.docId === ref.docId)
    if (existing !== undefined) {
      if (shell.state.getSnapshot().documentIds.includes(existing.descriptor.id)) return true
      return shell.addDocuments([existing.descriptor.id])
    }

    const descriptor: ComposerDocument = {
      kind: 'document',
      id: randomUUID() as DraftDocumentId,
      docId: ref.docId,
      name: ref.name,
      bytes: ref.bytes,
      mediaType: ref.mediaType,
      status: 'ready',
      progress: 1,
    }
    const entry: DraftDocumentEntry = {
      sessionId,
      controller: new AbortController(),
      ownsUploadedFile: false,
      descriptor,
    }
    this.draftDocuments.set(descriptor.id, entry)
    if (!shell.addDocuments([descriptor.id])) {
      this.draftDocuments.delete(descriptor.id)
      this.publishDocuments(sessionId)
      return false
    }
    this.publishDocuments(sessionId)
    return true
  }

  /**
   * Create browser-local document drafts and begin their uploads.
   * @param sessionId - owning session for the browser drafts.
   * @param files - browser files to upload.
   * @returns ordered descriptors for the new drafts.
   */
  createDraftDocuments(sessionId: SessionId, files: readonly File[]): readonly ComposerDocument[] {
    const descriptors: ComposerDocument[] = []
    for (const file of files) {
      const descriptor: ComposerDocument = {
        kind: 'document',
        id: randomUUID() as DraftDocumentId,
        name: file.name || 'document',
        bytes: file.size,
        mediaType: file.type || 'application/octet-stream',
        status: 'uploading',
        progress: 0,
      }
      descriptors.push(descriptor)
      const entry: DraftDocumentEntry = {
        sessionId,
        file,
        controller: new AbortController(),
        ownsUploadedFile: true,
        descriptor,
      }
      this.draftDocuments.set(descriptor.id, entry)
      void this.uploadDocument(descriptor.id, entry)
    }
    this.publishDocuments(sessionId)
    return descriptors
  }

  /**
   * Remove one document draft and delete its durable file when it exists.
   * @param sessionId - owning session for the draft.
   * @param id - browser-local draft document id.
   */
  removeDraftDocument(sessionId: SessionId, id: DraftDocumentId): void {
    const entry = this.draftDocuments.get(id)
    if (entry === undefined || entry.sessionId !== sessionId) return
    entry.controller.abort()
    this.draftDocuments.delete(id)
    this.publishDocuments(sessionId)
    if (entry.ownsUploadedFile && entry.descriptor.docId !== undefined) {
      void this.userDocs.remove(entry.descriptor.docId).catch(() => {
        // The draft is already gone; a later list/retry can reconcile an orphan.
      })
    }
  }

  /**
   * Retry a failed document upload in place.
   * @param sessionId - owning session for the draft.
   * @param id - browser-local draft document id.
   */
  retryDraftDocument(sessionId: SessionId, id: DraftDocumentId): void {
    const current = this.draftDocuments.get(id)
    if (
      current === undefined
      || current.sessionId !== sessionId
      || current.descriptor.status !== 'failed'
      || current.file === undefined
      || !current.ownsUploadedFile
    ) return
    const entry: DraftDocumentEntry = {
      ...current,
      controller: new AbortController(),
      descriptor: {
        kind: 'document',
        id: current.descriptor.id,
        name: current.descriptor.name,
        bytes: current.descriptor.bytes,
        mediaType: current.descriptor.mediaType,
        status: 'uploading',
        progress: 0,
      },
    }
    this.draftDocuments.set(id, entry)
    this.publishDocuments(sessionId)
    void this.uploadDocument(id, entry)
  }

  /**
   * Release browser draft metadata after a successful prompt; durable files remain.
   * @param sessionId - owning session for the drafts.
   * @param ids - browser-local draft document ids to release.
   */
  releaseDraftDocuments(sessionId: SessionId, ids: readonly DraftDocumentId[]): void {
    let changed = false
    for (const id of ids) {
      const entry = this.draftDocuments.get(id)
      if (entry?.sessionId !== sessionId) continue
      entry.controller.abort()
      this.draftDocuments.delete(id)
      changed = true
    }
    if (changed) this.publishDocuments(sessionId)
  }

  /**
   * Settle submitted image drafts when the Session observes their durable
   * attachment references. Failed admissions leave drafts untouched so the
   * composer can restore and retry them.
   */
  private settleSubmittedImages(
    sessionId: SessionId,
    attachments: readonly ComposerAttachment[],
    retirement: PendingSubmissionRetirement,
  ): void {
    if (retirement.reason !== 'observed') return
    attachments.forEach((attachment, index) => {
      const live = this.draftAttachments.get(attachment.id)
      if (live === undefined) return
      this.draftAttachments.delete(attachment.id)
      const ref = retirement.attachments[index]
      if (ref !== undefined && this.seedImageUrl(sessionId, ref, attachment.previewUrl)) return
      this.createdImageUrls.delete(attachment.previewUrl)
      revokePreview(attachment.previewUrl)
    })
  }

  /**
   * Resolve and cache one session-authorized historical image URL.
   * @param sessionId - owning session authorization scope.
   * @param attachment - durable image reference.
   * @returns browser URL valid until its rendered session is released.
   */
  resolveImage(sessionId: SessionId, attachment: ImageAttachmentRef): Promise<string> {
    if (this.disposed) return Promise.reject(new Error('conversation.resolveImage: service is disposed'))
    const key = `${sessionId}:${attachment.attachmentId}`
    const cached = this.imageUrls.get(key)
    if (cached !== undefined) return cached.pending
    const generation = this.imageGenerations.get(sessionId) ?? 0
    const session = this.requireSessions().binding(sessionId)?.session
    if (session === undefined) {
      return Promise.reject(new Error(`conversation.resolveImage: unknown session "${sessionId}"`))
    }
    const pending = this.loadCanonicalImage(session, sessionId, attachment, generation, key)
    this.imageUrls.set(key, { sessionId, generation, pending })
    return pending
  }

  /**
   * Return a synchronously available canonical or submission-preview URL.
   * @param sessionId - session authorization scope that owns the image.
   * @param attachment - durable image reference.
   * @returns a cached preview or canonical URL, when one is available.
   */
  peekImage(sessionId: SessionId, attachment: ImageAttachmentRef): string | undefined {
    return this.imageUrls.get(`${sessionId}:${attachment.attachmentId}`)?.current
  }

  /**
   * Hand a local submission preview to the durable image cache while the
   * canonical attachment URL is fetched. The preview is replaced once the
   * authenticated bytes resolve.
   * @param sessionId - session authorization scope that owns the image.
   * @param attachment - durable image reference observed in the accepted message.
   * @param previewUrl - browser-owned object URL to expose until canonical bytes resolve.
   * @returns true when the preview was adopted by the image cache.
   */
  seedImageUrl(sessionId: SessionId, attachment: ImageAttachmentRef, previewUrl: string): boolean {
    if (this.disposed) return false
    const key = `${sessionId}:${attachment.attachmentId}`
    if (this.imageUrls.has(key)) return false
    const generation = this.imageGenerations.get(sessionId) ?? 0
    const session = this.requireSessions().binding(sessionId)?.session
    if (session === undefined) return false
    const pending = this.loadCanonicalImage(session, sessionId, attachment, generation, key)
      .then((url) => {
        if (this.createdImageUrls.delete(previewUrl)) revokePreview(previewUrl)
        return url
      }, (error: unknown) => {
        if (this.createdImageUrls.delete(previewUrl)) revokePreview(previewUrl)
        throw error
      })
    this.createdImageUrls.add(previewUrl)
    this.imageUrls.set(key, { sessionId, generation, pending, current: previewUrl })
    return true
  }

  /** Load one canonical URL and enforce session-generation ownership. */
  private loadCanonicalImage(
    session: SessionFace,
    sessionId: SessionId,
    attachment: ImageAttachmentRef,
    generation: number,
    key: string,
  ): Promise<string> {
    return session.readAttachment(attachment.attachmentId)
      .then((result) => {
        if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`)
        if (this.disposed) throw new Error('conversation.resolveImage: service was disposed before loading completed')
        if ((this.imageGenerations.get(sessionId) ?? 0) !== generation) {
          throw new Error('historical image scope was released before loading completed')
        }
        if (typeof URL.createObjectURL !== 'function') {
          return `data:${result.value.attachment.mediaType};base64,${bytesToBase64(result.value.data)}`
        }
        const bytes = Uint8Array.from(result.value.data)
        const url = URL.createObjectURL(new Blob([bytes.buffer], { type: result.value.attachment.mediaType }))
        this.createdImageUrls.add(url)
        return url
      })
      .then((url) => {
        const entry = this.imageUrls.get(key)
        if (entry !== undefined && entry.generation === generation && entry.current !== undefined) {
          this.imageUrls.set(key, { ...entry, current: url })
        }
        return url
      })
      .catch((error: unknown) => {
        if (this.imageUrls.get(key)?.generation === generation) this.imageUrls.delete(key)
        throw error
      })
  }

  /**
   * Release every historical image URL owned by one rendered session.
   * @param sessionId - rendered session scope.
   */
  releaseSessionImages(sessionId: SessionId): void {
    this.imageGenerations.set(sessionId, (this.imageGenerations.get(sessionId) ?? 0) + 1)
    for (const [key, entry] of this.imageUrls) {
      if (entry.sessionId !== sessionId) continue
      this.imageUrls.delete(key)
      // A seeded submission owns its preview while the canonical bytes are
      // pending. Releasing the rendered session must revoke that browser URL
      // immediately; the pending load may never settle after cancellation.
      if (entry.current !== undefined && this.createdImageUrls.delete(entry.current)) {
        revokePreview(entry.current)
      }
      void entry.pending.then((url) => {
        if (!this.createdImageUrls.delete(url)) return
        revokePreview(url)
      }, () => {
        // A failed or invalidated load owns no object URL.
      })
    }
  }

  /** Apply one operation to a pending queue occurrence. */
  async updateQueue(itemId: QueueItemId, action: QueueAction): Promise<void> {
    const session = this.scopedSession('updateQueue')
    const result = await session.updateQueue(itemId, action)
    if (!result.ok) {
      if (
        action.kind === 'steer'
        && (result.error.code === 'steer-unavailable' || result.error.code === 'queue-item-not-found')
      ) return
      throw new Error(`conversation.updateQueue failed: ${result.error.code}: ${result.error.message}`)
    }
  }

  /** Cancel the scoped session's in-flight turn while preserving Queue (failures land in promptError and reject, as in send). */
  async cancel(): Promise<void> {
    const session = this.scopedSession('cancel')
    const result = await session.cancel()
    if (!result.ok) throw new Error(`conversation.cancel failed: ${result.error.code}: ${result.error.message}`)
  }

  /** Pull one older history page for the scoped Session. */
  async loadOlder(): Promise<void> {
    await this.scopedSession('loadOlder').loadOlder()
  }

  /** Resolve the caller scope's session face or throw on root contexts. */
  private scopedSession(op: string): SessionFace {
    const id = this.scopeId(op)
    const binding = this.requireSessions().binding(id)
    if (binding === undefined) throw new Error(`conversation.${op}: session "${id}" resolved no binding`)
    return binding.session
  }

  /** Read the caller's session scope tag via the sessions service; root contexts fail loud. */
  private scopeId(op: string): SessionId {
    const id = this.requireSessions().scopeOf(this.ctx)
    if (id === undefined) {
      throw new Error(`conversation.${op} requires a session scope — address one via ctx.sessions.scope(id).conversation`)
    }
    return id
  }

  private requireSessions(): ISessions {
    // Strict ctx.get, not the injection proxy: the scope-addressed pattern
    // reads the service off whatever context the tracker rebound.
    const sessions = this.ctx.get('sessions')
    if (sessions === undefined) throw new Error('conversation: sessions service unavailable')
    return sessions
  }

  /** Convert browser files to canonical base64 prompt parts. */
  private serializeImages(
    images: readonly File[],
    signal?: AbortSignal,
  ): Promise<Parameters<SessionFace['prompt']>[0]> {
    return Promise.all(images.map(async file => ({ type: 'image' as const, ...await this.encodeImage(file, signal) })))
  }

  /** Canonical base64 wire form of one browser image file. */
  private async encodeImage(file: File, signal?: AbortSignal): Promise<SubmitImageAttachment> {
    signal?.throwIfAborted()
    const bytes = await file.arrayBuffer()
    signal?.throwIfAborted()
    return {
      mediaType: imageMediaType(file.type),
      data: bytesToBase64(new Uint8Array(bytes)),
      ...(file.name === '' ? {} : { name: file.name }),
    }
  }

  private draftDocumentsFor(sessionId: SessionId, ids: readonly DraftDocumentId[]): readonly ReadyComposerDocument[] {
    return ids.flatMap((id) => {
      const entry = this.draftDocuments.get(id)
      if (entry?.sessionId !== sessionId || entry.descriptor.status !== 'ready' || entry.descriptor.docId === undefined) return []
      return [entry.descriptor as ReadyComposerDocument]
    })
  }

  private documentsFor(sessionId: SessionId): readonly ComposerDocument[] {
    return [...this.draftDocuments.values()]
      .filter(entry => entry.sessionId === sessionId)
      .map(entry => entry.descriptor)
  }

  private publishDocuments(sessionId: SessionId): void {
    this.documentStores.get(sessionId)?.set(this.documentsFor(sessionId))
  }

  private async uploadDocument(id: DraftDocumentId, entry: DraftDocumentEntry): Promise<void> {
    if (entry.file === undefined) return
    try {
      const ref = await this.userDocs.upload(entry.file, entry.controller.signal, (loaded, total) => {
        const current = this.draftDocuments.get(id)
        if (current !== entry) return
        current.descriptor = { ...current.descriptor, progress: total <= 0 ? 1 : Math.min(1, loaded / total) }
        this.publishDocuments(entry.sessionId)
      })
      const current = this.draftDocuments.get(id)
      if (current !== entry) return
      current.descriptor = {
        kind: 'document',
        id: current.descriptor.id,
        docId: ref.docId,
        name: ref.name,
        bytes: ref.bytes,
        mediaType: ref.mediaType,
        progress: 1,
        status: 'ready',
      }
      this.publishDocuments(entry.sessionId)
    } catch (error: unknown) {
      if (entry.controller.signal.aborted || this.draftDocuments.get(id) !== entry) return
      const message = error instanceof UserDocServiceUnavailableError
        ? error.message
        : error instanceof UserDocHttpError
          ? `${error.message}${error.code === undefined ? '' : ` (${error.code})`}`
          : error instanceof Error ? error.message : String(error)
      entry.descriptor = { ...entry.descriptor, status: 'failed', progress: 0, error: message }
      this.publishDocuments(entry.sessionId)
    }
  }
}

function imageMediaType(value: string): ImageMediaType {
  switch (value) {
    case 'image/png':
    case 'image/jpeg':
    case 'image/webp':
    case 'image/gif':
      return value
    default:
      throw new UnsupportedImageMediaTypeError(value)
  }
}

function revokePreview(url: string): void {
  if (url.startsWith('blob:')) URL.revokeObjectURL(url)
}

/** Resolve after the browser has had one paint opportunity. */
function nextPaint(): Promise<void> {
  if (typeof requestAnimationFrame === 'function') {
    return new Promise((resolve) => { requestAnimationFrame(() => { resolve() }) })
  }
  return new Promise((resolve) => { setTimeout(resolve, 0) })
}
