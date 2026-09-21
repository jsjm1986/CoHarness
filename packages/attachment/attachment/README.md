# @deepseek-ai/dsh-attachment

English | [中文](README.zh.md)

The durable attachment seam. `ctx.attachments` validates and durably commits a provider-independent normalized image, then returns a serializable `ImageAttachmentRef`; consumers never persist browser paths, object URLs, provider URLs, or base64 in session events.

Unsent composer images remain browser-owned temporary drafts. `validateImage` runs the complete admission policy without persisting. `saveImages` owns batch count and aggregate-byte limits, prepares every normalized attachment before publishing any member, then commits in order and returns references only after the complete batch succeeds. A later storage failure returns no partial references, although an earlier immutable content-addressed object may remain unreachable until reference-aware garbage collection exists. `AttachmentError.code` uses the closed `AttachmentErrorCode` string union. Its `ImageAdmissionErrorCode` subset marks caller-correctable image-input failures; `isImageAdmissionError` recognizes that subset at runtime so each protocol adapter can map its own error vocabulary. `saveImage` commits one accepted image before any model-visible session event is published and returns its `ImageAttachmentRef`. When normalization reduces the raster, the reference records the orientation-applied input size in `originalDimensions`. `readImage` verifies the normalized attachment against its logged metadata. `readImageRequest` deterministically derives a route-sized request version whose identity covers the attachment id, transform version, pixel and byte budgets, and encoder settings. Callers compose ordered batches with `Promise.all(refs.map(...))`; the local implementation still bounds compression through its instance limiter, cache, and singleflight. Callers may cancel reads and projections; implementations preserve cancellation instead of translating it into a storage failure.

`admitEncodedImages(attachments, images)` is the shared wire entry used by every RPC endpoint that accepts browser uploads (the session prompt endpoint and the command executor): it enforces canonical base64 on every member, then delegates batch admission — limits, validation, ordered commit — to `saveImages`. The base64 upload form is `EncodedImageAttachment`, exported from `@deepseek-ai/dsh-attachment/types` so wire contracts can reference it.

## Summary

Attach images and generic files to prompts and commands, then reuse them after restarting the same session, without extra setup in the shipped `dsh` composition. Images are validated and normalized before the message is accepted; PNG, JPEG, WebP, and GIF are supported within deployment limits. Other files are stored byte-for-byte without format or size limits, and models read them on demand through saved read-only paths instead of receiving their bytes. Durable session events exclude browser paths, provider URLs, local storage paths, and base64. Stored attachments are never deleted automatically; audio and video have no dedicated handling.

## Model Experience

Indirectly, through the provider adapter, which resolves each durable image reference into an exact request version and sends its stable attachment id and actual dimensions beside the image. When the execution filesystem maps the stored object, the descriptor also includes a read-only process path and a matching extension for a writable copy. A generic file never reaches the provider as bytes: every route receives one deterministic handle line naming the file, its byte size, its digest prefix, and the saved read-only path to read with file tools.

#### KV Cache effect

Adding an image changes the provider request and therefore invalidates the affected request suffix.

## Known Limitations and Deferred Work

- Version one accepts PNG, JPEG, WebP, and GIF only.
- Retention and garbage collection are deferred because resumed and forked sessions may share immutable objects.
- Generic files, audio, video, and persistent unsent drafts require separate lifecycle and provider contracts.

## Invariants

**Runtime invariant:** No companion is published. The service validates and commits each image through the mounted provider and returns serializable references; it owns no cache or second record of attachments to compare.
