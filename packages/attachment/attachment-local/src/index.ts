/** Local durable attachment backend rooted below `DSH_HOME`. @module @deepseek-ai/dsh-attachment-local */

import { join, resolve } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { AttachmentStore } from '@deepseek-ai/dsh-attachment'
import type {
  ImageAttachmentLimits,
  ImageAttachmentRef,
  ImageRequestPolicy,
  RequestImageAttachment,
  SaveImageAttachment,
  StoredImageAttachment,
} from '@deepseek-ai/dsh-attachment'
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths'
import { MAX_TIMER_DELAY_MS } from '@deepseek-ai/dsh-timeout'
import type { NormalizationPolicy } from './normalization.ts'
import { CompressionLimiter } from './compression-limiter.ts'
import { commitPreparedImageFile, normalizedImagePath, prepareImageFile, readImageFile, validateImageFile } from './store.ts'
import { pruneRequestImageCache, readRequestImageFile, requestImageVariantId } from './request-image.ts'

export { canPassThroughNormalization, normalizeImage } from './normalization.ts'
export type { NormalizedImage, NormalizationPolicy } from './normalization.ts'
export { commitPreparedImageFile, normalizedImagePath, prepareImageFile, readImageFile, saveImageFile, validateImageFile } from './store.ts'
export type { PreparedImageFile } from './store.ts'
export { pruneRequestImageCache, readRequestImageFile, requestImageDimensions, requestImageVariantId } from './request-image.ts'
export type { RequestImageCachePolicy } from './request-image.ts'

/** Default maximum encoded bytes for one submitted image; oversized sources are refused, not shrunk. */
export const DEFAULT_MAX_IMAGE_BYTES = 20 * 1024 * 1024
/** Default maximum images in one prompt. */
export const DEFAULT_MAX_IMAGES_PER_MESSAGE = 20
/** Default maximum aggregate image bytes in one prompt. */
export const DEFAULT_MAX_MESSAGE_IMAGE_BYTES = 200 * 1024 * 1024
/** Default maximum intrinsic pixels for one submitted image. */
export const DEFAULT_MAX_IMAGE_PIXELS = 64_000_000
/** Default per-side pixel cap for one submitted image. */
export const DEFAULT_MAX_IMAGE_DIMENSION = 8192
/**
 * Default long-edge target of the stored normalized image. A larger source
 * is admitted and downscaled to this edge, so admission bounds what rides
 * every later model request without refusing ordinary large sources.
 */
export const DEFAULT_NORMALIZED_IMAGE_MAX_DIMENSION = 2048
/** Default independent safety cap for one stored normalized image. */
export const DEFAULT_NORMALIZED_IMAGE_MAX_BYTES = 4 * 1024 * 1024
/** Conservative default number of simultaneous native image transformations per store. */
export const DEFAULT_IMAGE_COMPRESSION_CONCURRENCY = 2
/** Maximum configurable native image transformations per store. */
export const MAX_IMAGE_COMPRESSION_CONCURRENCY = 8
/** Default aggregate bytes retained by derived request-image files. */
export const DEFAULT_REQUEST_IMAGE_CACHE_MAX_BYTES = 512 * 1024 * 1024
/** Default number of derived request-image files retained. */
export const DEFAULT_REQUEST_IMAGE_CACHE_MAX_ENTRIES = 2_048
/** Default idle age before a derived request-image file is removed. */
export const DEFAULT_REQUEST_IMAGE_CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000
/** Default interval between derived request-image cache sweeps. */
export const DEFAULT_REQUEST_IMAGE_CACHE_GC_INTERVAL_MS = 15 * 60 * 1000

/** Local attachment backend configuration. */
export interface Config {
  /** Explicit harness home; omitted follows `DSH_HOME`, then `~/.dsh`. */
  dshHome?: string
  /** Maximum encoded bytes accepted for one submitted image. Default: 20 MiB. */
  maxImageBytes?: number
  /** Maximum image count accepted in one submitted message. Default: 20. */
  maxImagesPerMessage?: number
  /** Maximum aggregate encoded image bytes accepted in one submitted message. Default: 200 MiB. */
  maxMessageImageBytes?: number
  /** Maximum intrinsic width multiplied by height accepted for one submitted image. Default: 64,000,000. */
  maxImagePixels?: number
  /** Maximum intrinsic width and maximum intrinsic height accepted for one submitted image. Default: 8192px. */
  maxImageDimension?: number
  /** Long-edge pixel cap of the stored provider-independent normalized image. */
  normalizedImageMaxDimension?: number
  /** Encoded-byte safety cap of the stored provider-independent normalized image. */
  normalizedImageMaxBytes?: number
  /** Maximum simultaneous normalization or request-image transformations in this service instance. */
  imageCompressionConcurrency?: number
  /** Maximum aggregate bytes retained by derived request-image files. */
  requestImageCacheMaxBytes?: number
  /** Maximum number of derived request-image files retained. */
  requestImageCacheMaxEntries?: number
  /** Maximum idle age of a derived request-image file before cleanup. */
  requestImageCacheTtlMs?: number
  /** Interval between derived request-image cache cleanup sweeps. */
  requestImageCacheGcIntervalMs?: number
}

function abortReason(signal: AbortSignal): Error {
  const reason: unknown = signal.reason
  return reason instanceof Error
    ? reason
    : new Error('Attachment request cancelled with a non-Error reason.', { cause: reason })
}

function positiveSafeInteger(value: number | undefined, fallback: number, name: string): number {
  const resolved = value ?? fallback
  if (!Number.isSafeInteger(resolved) || resolved <= 0) {
    throw new Error(`attachment-local: ${name} must be a positive safe integer`)
  }
  return resolved
}

class SharedRequest<T> {
  readonly controller = new AbortController()
  readonly promise: Promise<T>
  private settled = false
  private waiters = 0

  constructor(start: (signal: AbortSignal) => Promise<T>) {
    this.promise = start(this.controller.signal).finally(() => {
      this.settled = true
    })
  }

  wait(signal?: AbortSignal): Promise<T> {
    signal?.throwIfAborted()
    this.waiters += 1
    if (signal === undefined) {
      return this.promise.finally(() => {
        this.release(false)
      })
    }
    let released = false
    const release = (cancelled: boolean): void => {
      if (released) return
      released = true
      this.release(cancelled, signal)
    }
    return new Promise<T>((resolve, reject) => {
      const abort = (): void => {
        release(true)
        reject(abortReason(signal))
      }
      signal.addEventListener('abort', abort, { once: true })
      // AbortSignal does not replay an already-fired event to a listener
      // added afterwards. Recheck after registration so a cancellation in the
      // registration window cannot leave this waiter attached forever.
      if (signal.aborted) abort()
      void this.promise.then((value) => {
        signal.removeEventListener('abort', abort)
        release(false)
        resolve(value)
      }, (error: unknown) => {
        signal.removeEventListener('abort', abort)
        release(false)
        // CompressionLimiter normalizes task rejections before this handler.
        // oxlint-disable-next-line typescript/prefer-promise-reject-errors
        reject(error)
      })
    })
  }

  private release(cancelled: boolean, signal?: AbortSignal): void {
    this.waiters -= 1
    if (cancelled && this.waiters === 0 && !this.settled && signal !== undefined) {
      this.controller.abort(abortReason(signal))
    }
  }
}

/** Persistent content-addressed local attachment store. */
export class LocalAttachmentStore extends AttachmentStore {
  static Config: z<Config> = z.object({
    dshHome: z.string(),
    maxImageBytes: z.number().step(1).min(1).default(DEFAULT_MAX_IMAGE_BYTES),
    maxImagesPerMessage: z.number().step(1).min(1).default(DEFAULT_MAX_IMAGES_PER_MESSAGE),
    maxMessageImageBytes: z.number().step(1).min(1).default(DEFAULT_MAX_MESSAGE_IMAGE_BYTES),
    maxImagePixels: z.number().step(1).min(1).default(DEFAULT_MAX_IMAGE_PIXELS),
    maxImageDimension: z.number().step(1).min(1).default(DEFAULT_MAX_IMAGE_DIMENSION),
    normalizedImageMaxDimension: z.number().step(1).min(1).default(DEFAULT_NORMALIZED_IMAGE_MAX_DIMENSION),
    normalizedImageMaxBytes: z.number().step(1).min(1).default(DEFAULT_NORMALIZED_IMAGE_MAX_BYTES),
    imageCompressionConcurrency: z.number().step(1).min(1).max(MAX_IMAGE_COMPRESSION_CONCURRENCY)
      .default(DEFAULT_IMAGE_COMPRESSION_CONCURRENCY),
    requestImageCacheMaxBytes: z.number().step(1).min(1).default(DEFAULT_REQUEST_IMAGE_CACHE_MAX_BYTES),
    requestImageCacheMaxEntries: z.number().step(1).min(1).default(DEFAULT_REQUEST_IMAGE_CACHE_MAX_ENTRIES),
    requestImageCacheTtlMs: z.number().step(1).min(1).default(DEFAULT_REQUEST_IMAGE_CACHE_TTL_MS),
    requestImageCacheGcIntervalMs: z.number().step(1).min(1).default(DEFAULT_REQUEST_IMAGE_CACHE_GC_INTERVAL_MS),
  })

  /** Absolute versioned storage root. */
  readonly root: string
  readonly imageLimits: ImageAttachmentLimits
  /** Resolved provider-independent normalization policy. */
  readonly normalizationPolicy: Readonly<NormalizationPolicy>
  /** Resolved instance-level compression limit. */
  readonly imageCompressionConcurrency: number
  private readonly compression: CompressionLimiter
  private readonly requestInflight = new Map<string, SharedRequest<RequestImageAttachment>>()
  private readonly requestImageCachePolicy: Readonly<{
    maxBytes: number
    maxEntries: number
    ttlMs: number
  }>
  private readonly requestImageCacheGcTimer: ReturnType<typeof setInterval>

  constructor(ctx: Context, config: Config) {
    super(ctx)
    this.root = resolve(join(resolveDshHome(config.dshHome), 'attachments', 'v1'))
    this.imageLimits = Object.freeze({
      maxImageBytes: config.maxImageBytes ?? DEFAULT_MAX_IMAGE_BYTES,
      maxImagesPerMessage: config.maxImagesPerMessage ?? DEFAULT_MAX_IMAGES_PER_MESSAGE,
      maxMessageImageBytes: config.maxMessageImageBytes ?? DEFAULT_MAX_MESSAGE_IMAGE_BYTES,
      maxImagePixels: config.maxImagePixels ?? DEFAULT_MAX_IMAGE_PIXELS,
      maxImageDimension: config.maxImageDimension ?? DEFAULT_MAX_IMAGE_DIMENSION,
      mediaTypes: Object.freeze(['image/png', 'image/jpeg', 'image/webp', 'image/gif'] as const),
    })
    this.normalizationPolicy = Object.freeze({
      maxDimension: config.normalizedImageMaxDimension ?? DEFAULT_NORMALIZED_IMAGE_MAX_DIMENSION,
      maxBytes: config.normalizedImageMaxBytes ?? DEFAULT_NORMALIZED_IMAGE_MAX_BYTES,
    })
    const compressionConcurrency = config.imageCompressionConcurrency ?? DEFAULT_IMAGE_COMPRESSION_CONCURRENCY
    if (!Number.isSafeInteger(compressionConcurrency)
      || compressionConcurrency < 1
      || compressionConcurrency > MAX_IMAGE_COMPRESSION_CONCURRENCY) {
      throw new Error(
        `attachment-local: imageCompressionConcurrency must be an integer from 1 through ${MAX_IMAGE_COMPRESSION_CONCURRENCY}`,
      )
    }
    this.imageCompressionConcurrency = compressionConcurrency
    this.compression = new CompressionLimiter(compressionConcurrency)
    this.requestImageCachePolicy = Object.freeze({
      maxBytes: positiveSafeInteger(config.requestImageCacheMaxBytes, DEFAULT_REQUEST_IMAGE_CACHE_MAX_BYTES, 'requestImageCacheMaxBytes'),
      maxEntries: positiveSafeInteger(config.requestImageCacheMaxEntries, DEFAULT_REQUEST_IMAGE_CACHE_MAX_ENTRIES, 'requestImageCacheMaxEntries'),
      ttlMs: positiveSafeInteger(config.requestImageCacheTtlMs, DEFAULT_REQUEST_IMAGE_CACHE_TTL_MS, 'requestImageCacheTtlMs'),
    })
    const gcIntervalMs = config.requestImageCacheGcIntervalMs ?? DEFAULT_REQUEST_IMAGE_CACHE_GC_INTERVAL_MS
    if (!Number.isSafeInteger(gcIntervalMs) || gcIntervalMs <= 0 || gcIntervalMs > MAX_TIMER_DELAY_MS) {
      throw new Error(
        `attachment-local: requestImageCacheGcIntervalMs must be a positive safe integer no greater than ${MAX_TIMER_DELAY_MS}`,
      )
    }
    this.requestImageCacheGcTimer = setInterval(() => {
      void pruneRequestImageCache(this.root, this.requestImageCachePolicy).catch((error: unknown) => {
        console.error('[attachment-local] request-image cache cleanup failed:', error)
      })
    }, gcIntervalMs)
    this.requestImageCacheGcTimer.unref()
    ctx.effect(() => {
      return () => { clearInterval(this.requestImageCacheGcTimer) }
    }, 'request-image cache cleanup')
  }

  async validateImage(input: SaveImageAttachment): Promise<void> {
    await this.compression.run(() => validateImageFile(input, this.imageLimits, this.normalizationPolicy))
  }

  override async saveImages(inputs: readonly SaveImageAttachment[]): Promise<readonly ImageAttachmentRef[]> {
    super.validateImageBatch(inputs)
    const prepared = await Promise.all(inputs.map(input => this.compression.run(
      () => prepareImageFile(input, this.imageLimits, this.normalizationPolicy),
    )))
    const refs: ImageAttachmentRef[] = []
    for (const image of prepared) refs.push(await commitPreparedImageFile(this.root, image))
    return refs
  }

  async saveImage(input: SaveImageAttachment): Promise<ImageAttachmentRef> {
    const prepared = await this.compression.run(
      () => prepareImageFile(input, this.imageLimits, this.normalizationPolicy),
    )
    return commitPreparedImageFile(this.root, prepared)
  }

  async readImage(ref: ImageAttachmentRef, signal?: AbortSignal): Promise<StoredImageAttachment> {
    return readImageFile(this.root, ref, signal)
  }

  /** Expose only the immutable normalized object path to local execution-world adapters. */
  override imageHostPath(ref: ImageAttachmentRef): string {
    return normalizedImagePath(this.root, ref)
  }

  override async readImageRequest(
    ref: ImageAttachmentRef,
    policy: ImageRequestPolicy,
    signal?: AbortSignal,
  ): Promise<RequestImageAttachment> {
    return this.requestVersion(ref, policy, undefined, signal)
  }

  private requestVersion(
    ref: ImageAttachmentRef,
    policy: ImageRequestPolicy,
    stored: StoredImageAttachment | undefined,
    signal: AbortSignal | undefined,
  ): Promise<RequestImageAttachment> {
    signal?.throwIfAborted()
    const variantId = requestImageVariantId(ref, policy)
    const key = String(variantId)
    let operation = this.requestInflight.get(key)
    if (operation?.controller.signal.aborted) {
      this.requestInflight.delete(key)
      operation = undefined
    }
    if (operation === undefined) {
      const shared = new SharedRequest<RequestImageAttachment>(sharedSignal => this.compression.run(async () => readRequestImageFile(
        this.root,
        stored ?? await this.readImage(ref, sharedSignal),
        policy,
        sharedSignal,
      ), { signal: sharedSignal }))
      operation = shared
      this.requestInflight.set(key, shared)
      void shared.promise.finally(() => {
        if (this.requestInflight.get(key) === shared) this.requestInflight.delete(key)
      }).catch(() => {})
    }
    return operation.wait(signal)
  }

}

export default LocalAttachmentStore
