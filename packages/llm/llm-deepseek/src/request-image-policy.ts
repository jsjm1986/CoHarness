/**
 * Request-image budget policy for DeepSeek routes: the per-model pixel and
 * encoded-byte budgets the adapter projects images against, shared by the
 * pricing path so cost estimation reproduces the request projection exactly.
 *
 * @module dsh-llm-deepseek/request-image-policy
 */

import type { ImageRequestPolicy } from '@deepseek-ai/dsh-attachment'
import type { DeepSeekCatalogModel } from './adapter.ts'

/** Default bound on accumulated file-referenced image bytes per request. */
export const DEFAULT_MAX_REQUEST_FILES_BYTES = 128 * 1024 * 1024
/** Provider request image-count limit. */
export const DEFAULT_MAX_IMAGES_PER_REQUEST = 600
/** Total-pixel budget matching DeepSeek's normal vision projection. */
export const DEFAULT_REQUEST_IMAGE_PIXEL_BUDGET = 640_000
/** Total-pixel budget matching provider low-detail image input. */
export const DEFAULT_LOW_DETAIL_IMAGE_PIXEL_BUDGET = 512 * 512
/** Encoded-byte cap for one deterministic model-request image. */
export const DEFAULT_REQUEST_IMAGE_MAX_BYTES = 1024 * 1024

/**
 * Resolve the request-image budgets owned by one DeepSeek model route.
 * @param model - Advertised model route and its optional image overrides.
 * @returns Complete pixel and encoded-byte budgets.
 * @internal
 */
export function resolveRequestImagePolicy(model: DeepSeekCatalogModel): ImageRequestPolicy {
  let maxPixels: number
  if (model.imagePixelBudget !== undefined && model.imagePixelBudget !== 'low') maxPixels = model.imagePixelBudget
  else if (model.imagePixelBudget === 'low' || model.imageDetail === 'low') maxPixels = DEFAULT_LOW_DETAIL_IMAGE_PIXEL_BUDGET
  else maxPixels = DEFAULT_REQUEST_IMAGE_PIXEL_BUDGET
  return {
    maxPixels,
    maxBytes: model.imageMaxBytes === undefined
      ? DEFAULT_REQUEST_IMAGE_MAX_BYTES
      : model.imageMaxBytes,
  }
}
