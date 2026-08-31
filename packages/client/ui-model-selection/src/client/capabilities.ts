/** Input capability disclosed by one model catalog row. */
export type ModelInputCapability = 'image' | 'text'

interface ModelCapabilitySource {
  inputModalities?: readonly ('text' | 'image')[]
}

/**
 * Resolve the model's declared input capability without guessing when the
 * provider omitted its metadata.
 * @param model - catalog row supplied by the Host.
 * @returns image-capable, text-only, or undefined when the provider did not disclose it.
 */
export function modelInputCapability(
  model: ModelCapabilitySource,
): ModelInputCapability | undefined {
  if (model.inputModalities === undefined) return undefined
  return model.inputModalities.includes('image') ? 'image' : 'text'
}
