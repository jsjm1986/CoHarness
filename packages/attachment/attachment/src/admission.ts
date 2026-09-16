/** Wire-form admission of base64-encoded image uploads. @module @deepseek-ai/dsh-attachment/admission */

import { Buffer } from 'node:buffer'
import { AttachmentError } from './error.ts'
import type { AttachmentStore } from './index.ts'
import type {
  AdmittedPromptContentPart,
  AttachmentAdmissionPart,
  EncodedImageAttachment,
  ImageAttachmentRef,
  SaveImageAttachment,
} from './types.ts'

/** Decode one upload payload while rejecting non-canonical base64 forms. */
function decodeBase64(data: string): Uint8Array {
  const decoded = Buffer.from(data, 'base64')
  if (data.length === 0 || decoded.toString('base64') !== data) {
    throw new AttachmentError('Image upload is not canonical base64.', 'INVALID_IMAGE_BASE64')
  }
  return new Uint8Array(decoded)
}

/** Store input for one decoded upload. */
function saveInput(image: EncodedImageAttachment): SaveImageAttachment {
  return {
    data: decodeBase64(image.data),
    mediaType: image.mediaType,
    ...image.name === undefined ? {} : { name: image.name },
  }
}

/**
 * Admit one wire image batch: enforce canonical base64 on every member, then
 * delegate batch admission — count and aggregate-byte limits, media-type and
 * per-image validation, ordered commit — to {@link AttachmentStore.saveImages}.
 * The shared entry for every RPC endpoint accepting browser uploads.
 * @param attachments - the deployment attachment store owning batch policy.
 * @param images - base64-encoded uploads in caller order.
 * @returns durable references in the same order as `images`.
 * @throws AttachmentError on a non-canonical payload or a refused batch.
 */
export async function admitEncodedImages(
  attachments: AttachmentStore,
  images: readonly EncodedImageAttachment[],
): Promise<readonly ImageAttachmentRef[]> {
  return attachments.saveImages(images.map(saveInput))
}

/**
 * Admit one Host prompt and replace each uploaded image with its durable
 * reference. Text parts pass through unchanged; a prompt without image parts
 * performs no storage operation.
 * @param attachments - the deployment attachment store owning batch policy.
 * @param content - prompt parts in message order.
 * @returns admitted prompt parts in the same order as `content`.
 * @throws AttachmentError when the image batch is refused.
 */
export async function admitPromptContent(
  attachments: AttachmentStore,
  content: readonly AttachmentAdmissionPart[],
): Promise<AdmittedPromptContentPart[]> {
  const images = content.filter((part): part is Extract<AttachmentAdmissionPart, { type: 'image' }> =>
    part.type === 'image')
  const refs = images.length === 0 ? [] : await admitEncodedImages(attachments, images)
  let next = 0
  return content.map((part): AdmittedPromptContentPart => part.type === 'text'
    ? { type: 'text', text: part.text }
    : { type: 'image', attachment: refs[next++] as ImageAttachmentRef })
}
