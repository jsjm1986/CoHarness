# 持久图片附件

[English](attachment.md) | 中文

附件 seam 将二进制图片的所有权与会话日志分离。生产方把经过校验的编码字节交给 [`ctx.attachments`](#ctxattachments--attachmentstore-abstract-seam)；只有对象完成持久化后，该服务才会发布不可变的内容寻址引用。会话事件和模型可见的 `ImageBlock` 包含该引用及其元数据，绝不包含浏览器对象 URL、宿主临时路径、提供方 URL 或 base64 数据。

未发送的浏览器草稿可以保留在内存中，原生客户端也可以将其暂存于操作系统临时存储。宿主接受用户消息后，会先把消息中的图片移到 `<DSH_HOME>/attachments/v1` 下，再追加用户事件。结构化模型图片输出遵循同样的先持久化、后追加事件规则。

来源：[`packages/attachment/attachment/src/types.ts`](../../packages/attachment/attachment/src/types.ts)

## 标识与经过校验的元数据

`AttachmentId` 是带类型标记的不透明字符串。本地后端目前生成 `sha256:<digest>`，但消费方既不能解析这种表示，也不能据此派生文件系统路径。

```ts type-equiv
/** Raster image formats accepted by the version-one attachment path. */
type ImageMediaType = 'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif'
```

```ts type-equiv
/** Durable, serializable reference to one immutable normalized image. */
interface ImageAttachmentRef {
  /** Opaque storage identifier; never a filesystem path or bearer URL. */
  attachmentId: AttachmentId
  /** Media type verified from the stored bytes. */
  mediaType: ImageMediaType
  /** Exact encoded byte length. */
  bytes: number
  /** Intrinsic encoded width in pixels. */
  width: number
  /** Intrinsic encoded height in pixels. */
  height: number
  /** Optional display name stripped of local path information. */
  name?: string
  /**
   * Input dimensions after applying EXIF orientation and before normalization
   * scaling. Present only when normalization reduced the image.
   */
  originalDimensions?: {
    width: number
    height: number
  }
}
```

```ts type-equiv
/** Deployment-resolved limits used by upload admission and request buffering. */
interface ImageAttachmentLimits {
  maxImageBytes: number
  maxImagesPerMessage: number
  maxMessageImageBytes: number
  maxImagePixels: number
  /** Maximum intrinsic width and maximum intrinsic height in pixels for one image. */
  maxImageDimension: number
  mediaTypes: readonly ImageMediaType[]
}
```

引用记录固有尺寸和编码长度，使客户端无需先解码即可排布历史记录；每次权威读取仍会根据对象重新校验摘要、媒体签名、尺寸和元数据。

## 提交与经校验读取的数据

```ts type-equiv
/** Base64-encoded image upload accompanying one wire request. */
interface EncodedImageAttachment {
  /** Declared media type, verified against the decoded bytes during admission. */
  mediaType: ImageMediaType
  /** Canonical base64 encoding of the image bytes. */
  data: string
  /** Optional display name; it is never interpreted as a path. */
  name?: string
}
```

```ts type-equiv
/** Request to validate and durably commit one image. */
interface SaveImageAttachment {
  data: Uint8Array
  /** Caller-declared media type, checked against fully decoded bytes. */
  mediaType: ImageMediaType
  /** Optional browser/provider display name; it is never interpreted as a path. */
  name?: string
}
```

```ts type-equiv
/** Stored image bytes returned after reference and digest verification. */
interface StoredImageAttachment {
  ref: ImageAttachmentRef
  data: Uint8Array
}
```

`saveImage()` 校验字节并以原子方式提交一个对象，之后才返回其引用。`validateImage()` 执行相同的准入检查，但不持久化任何内容；批量调用方会在保存任何成员前通过它校验所有成员，因此校验拒绝不会留下部分对象。`admitEncodedImages()` 是面向 base64 上传的 wire 入口：强制执行规范 base64，随后把批量准入委托给 `saveImages()`，由后者负责张数与聚合字节上限以及先全量校验再保存的顺序。`readImage()` 接受来自已授权会话路径的引用，只在完整性校验通过后返回字节。该服务刻意不规定保留策略：恢复和 fork 后的会话可能共享对象，因此基于引用的垃圾回收会延期实现，而不是与任何一个会话的删除绑定。

<!-- BEGIN GENERATED cordis-surface (gen-cordis-catalog.ts) — do not edit between markers -->

<a id="cordis-surface"></a>

## Cordis API

Generated from source by `scripts/gen-cordis-catalog.ts` (verified fresh by `pnpm run verify-cordis-catalog` in doc-sync; regenerate with `pnpm run gen-cordis-catalog`) — this section is byte-identical in both language sides of the page. Signature blocks use a `ts cordis-catalog` fence and keep the original source JSDoc; dispatch modes are defined in the [primer](../cordis-primer.zh.md#dispatch-modes), and the framework-inherited `ctx` API lives in [cordis-api/inherited.md](../cordis-api/inherited.md).

<a id="ctxattachments--attachmentstore-abstract-seam"></a>

### `ctx.attachments` — `AttachmentStore` (abstract seam)

Immutable binary attachment service. Implementations validate bytes before publishing a reference.

```ts cordis-catalog
/**
 * Validate one image without persisting it.
 * Batch callers validate every member before saving any member.
 * @param input - encoded bytes, declared media type, and optional display name.
 * @returns completion after the encoded raster has been fully decoded.
 */
abstract validateImage(input: SaveImageAttachment): Promise<void>

/**
 * Validate and durably commit one ordered image batch.
 * @param inputs - encoded images in owning-message order.
 * @returns durable normalized attachment references in the same order after every member succeeds.
 */
async saveImages(inputs: readonly SaveImageAttachment[]): Promise<readonly ImageAttachmentRef[]>

/**
 * Validate and durably commit one image before its owning session event is appended.
 * The returned reference describes the persisted normalized image. When
 * normalization reduces the raster, its `originalDimensions` records the
 * orientation-applied input dimensions.
 * @param input - encoded bytes, declared media type, and optional display name.
 * @returns the durable content-addressed normalized image reference.
 */
abstract saveImage(input: SaveImageAttachment): Promise<ImageAttachmentRef>

/**
 * Read one image and verify that bytes still match the recorded reference.
 * @param ref - durable reference from the session log.
 * @param signal - optional cancellation for backend read and verification work.
 * @returns the verified bytes and normalized attachment reference.
 * @throws the signal reason when aborted, or a storage error when verification fails.
 */
abstract readImage(ref: ImageAttachmentRef, signal?: AbortSignal): Promise<StoredImageAttachment>

/**
 * Generate or read one deterministic model-request version from the stored normalized image.
 * @param ref - durable provider-independent normalized attachment reference.
 * @param policy - exact route pixel and encoded-byte budget.
 * @param signal - optional cancellation.
 * @returns request bytes and the cache/upload identity covering every transform input.
 */
readImageRequest( ref: ImageAttachmentRef, policy: ImageRequestPolicy, signal?: AbortSignal, ): Promise<RequestImageAttachment>
```

Source: [`packages/attachment/attachment/src/index.ts:37`](../../packages/attachment/attachment/src/index.ts)

<a id="ctxuserdocs--userdocstore-abstract-seam"></a>

### `ctx.userDocs` — `UserDocStore` (abstract seam)

Storage for documents a user uploads into their own workspace.

The stored form is an ordinary named file, not an opaque object: a document lands at a real path the agent's filesystem and shell tools can read, which is what lets one uploaded file serve every format without this seam knowing any of them. Nothing here inspects, parses, or whitelists content — `mediaType` is recorded and never acted upon, so an unrecognized format is stored exactly like a recognized one and the agent decides how to read it.

Writes are two explicit steps. `resolveTarget` sanitizes the untrusted client name and computes the path; `save` streams bytes to that path. Naming policy therefore has one auditable home, and `save` never defaults a target of its own.

```ts cordis-catalog
/**
 * Resolve one untrusted client file name to the absolute path a `save` will
 * create. Implementations sanitize the name, keep the result inside the
 * document root, and pick a leaf that no existing entry holds.
 * @param input - client-supplied name, treated as untrusted text.
 * @returns the resolved write target.
 * @throws UserDocError when no acceptable free name can be derived from the input.
 */
abstract resolveTarget(input: ResolveUserDocTarget): Promise<UserDocTarget>

/**
 * Stream one document to a resolved target and publish its reference.
 *
 * Implementations enforce a finite `maxFileBytes` while streaming, so an
 * oversized upload is cut off rather than buffered; `null` accepts every
 * document size supported by the transport and filesystem. Failed or
 * cancelled writes leave no partial file behind. The recorded `mediaType` is
 * derived from the stored name, never taken from a client header: a declared
 * type is unverifiable here, and nothing in this seam acts on the value anyway.
 * @param target - a target from this store's own `resolveTarget`.
 * @param body - the upload byte stream.
 * @param signal - optional cancellation for the streaming write.
 * @returns the durable reference to the stored document.
 * @throws UserDocError when a finite `maxFileBytes` is exceeded or the write fails.
 */
abstract save( target: UserDocTarget, body: ReadableStream<Uint8Array>, signal?: AbortSignal, ): Promise<UserDocRef>

/**
 * Create or reuse a resumable upload session.
 * @param input - untrusted browser metadata validated by the provider.
 * @returns the public upload session state.
 */
abstract beginUpload(input: BeginUserDocUpload): Promise<UserDocUploadSession>

/**
 * Read one upload session's public state.
 * @param uploadId - opaque provider-produced identifier.
 * @param signal - optional cancellation.
 * @returns current upload state.
 */
abstract inspectUpload(uploadId: UserDocUploadId, signal?: AbortSignal): Promise<UserDocUploadSession>

/**
 * Append one sequential chunk to an upload session.
 * @param uploadId - opaque provider-produced identifier.
 * @param chunk - validated range, digest, and raw body.
 * @param signal - optional cancellation.
 * @returns updated public upload state.
 */
abstract writeUploadChunk( uploadId: UserDocUploadId, chunk: UserDocUploadChunk, signal?: AbortSignal, ): Promise<UserDocUploadSession>

/**
 * Start or repeat final verification and publication.
 * @param uploadId - opaque provider-produced identifier.
 * @param sha256 - final SHA-256 digest supplied by the browser.
 * @param signal - optional cancellation.
 * @returns verifying, complete, or failed public state.
 */
abstract completeUpload( uploadId: UserDocUploadId, sha256: string, signal?: AbortSignal, ): Promise<UserDocUploadSession>

/**
 * Cancel and remove one incomplete upload session.
 * @param uploadId - opaque provider-produced identifier.
 * @param signal - optional cancellation.
 * @returns after temporary data is removed.
 */
abstract cancelUpload(uploadId: UserDocUploadId, signal?: AbortSignal): Promise<void>

/**
 * List every stored document, newest modification first.
 * @param signal - optional cancellation for the directory scan.
 * @returns references to all stored documents; empty before the first upload.
 */
abstract list(signal?: AbortSignal): Promise<UserDocRef[]>

/**
 * List one directory's immediate children.
 * @param directoryId - store-scoped directory identifier; the empty identifier selects the root.
 * @param signal - optional cancellation for the directory scan.
 * @returns immediate directories and documents.
 * @throws UserDocError when the identifier is invalid or the directory is absent.
 */
abstract listDirectory( directoryId: UserDocDirectoryId, signal?: AbortSignal, ): Promise<UserDocDirectoryListing>

/**
 * List every directory below the document root.
 * @param signal - optional cancellation for the recursive scan.
 * @returns directory references ordered by identifier.
 */
abstract listDirectories(signal?: AbortSignal): Promise<UserDocDirectoryRef[]>

/**
 * Create one directory below an existing parent.
 * @param parentDirectoryId - parent directory; the empty identifier selects the root.
 * @param name - untrusted directory leaf name.
 * @returns the created directory reference.
 * @throws UserDocError when the name is invalid, the parent is absent, or the target exists.
 */
abstract createDirectory( parentDirectoryId: UserDocDirectoryId, name: string, ): Promise<UserDocDirectoryRef>

/**
 * Rename one directory within its current parent.
 * @param directoryId - non-root directory to rename.
 * @param name - untrusted replacement leaf name.
 * @returns the renamed directory reference.
 * @throws UserDocError when the directory is absent, the name is invalid, or the target exists.
 */
abstract renameDirectory(directoryId: UserDocDirectoryId, name: string): Promise<UserDocDirectoryRef>

/**
 * Delete one empty, non-root directory.
 * @param directoryId - directory to delete.
 * @returns after the directory is gone.
 * @throws UserDocError when the directory is absent, non-empty, or identifies the root.
 */
abstract removeDirectory(directoryId: UserDocDirectoryId): Promise<void>

/**
 * Move one document into an existing directory without replacing an entry.
 * @param docId - document to move.
 * @param directoryId - destination directory; the empty identifier selects the root.
 * @returns the moved document reference.
 * @throws UserDocError when either identifier is invalid or the destination is occupied.
 */
abstract move(docId: UserDocId, directoryId: UserDocDirectoryId): Promise<UserDocRef>

/**
 * Resolve one identifier to its current reference.
 *
 * Every read path takes this identifier rather than a `UserDocRef`, because a
 * reference carries an absolute path and a caller's copy of one is untrusted
 * input. Implementations re-derive the path from the identifier and re-prove
 * containment, so a tampered path cannot name a file outside the document root.
 * @param docId - identifier from a previous `save` or `list`.
 * @param signal - optional cancellation for the filesystem probe.
 * @returns the current reference.
 * @throws UserDocError when the identifier is malformed, escapes the document root, or names no file.
 */
abstract stat(docId: UserDocId, signal?: AbortSignal): Promise<UserDocRef>

/**
 * Read one stored document in full.
 * @param docId - identifier from a previous `save` or `list`.
 * @param signal - optional cancellation for the read.
 * @returns the bytes and the reference they were read through.
 * @throws the signal reason when aborted, or a UserDocError when the identifier does not resolve to a file.
 */
abstract read(docId: UserDocId, signal?: AbortSignal): Promise<StoredUserDoc>

/**
 * Open one stored document as a byte stream, for a download response that must
 * not hold the whole file in memory.
 * @param docId - identifier from a previous `save` or `list`.
 * @returns the reference and its byte stream.
 * @throws UserDocError when the identifier does not resolve to a file.
 */
abstract openRead(docId: UserDocId): Promise<{ ref: UserDocRef; body: ReadableStream<Uint8Array> }>

/**
 * Delete one stored document. Deleting an already-absent document succeeds, so
 * a client retrying a delete it already completed is not an error.
 * @param docId - identifier from a previous `save` or `list`.
 * @param signal - optional cancellation.
 * @returns after the entry is gone.
 * @throws UserDocError when the identifier is malformed or escapes the document
 * root, or the deletion fails for any reason other than absence.
 */
abstract remove(docId: UserDocId, signal?: AbortSignal): Promise<void>
```

Source: [`packages/attachment/userdoc/src/index.ts:110`](../../packages/attachment/userdoc/src/index.ts)
<!-- END GENERATED cordis-surface -->
