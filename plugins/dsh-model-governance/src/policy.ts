import { readFileSync } from 'node:fs'

export interface GovernancePolicyFile {
  version: number
  defaultAllowed: boolean
  /**
   * Whether routes absent from `models` are authorized when the instance's own
   * settings user layer declares the provider (personal BYOK). The gateway
   * writes `true` for personal runtimes and `false` for shared project
   * runtimes; a route present in `models` always follows its catalog entry.
   */
  userDeclaredAllowed: boolean
  models: Array<{ provider: string; model: string; allowed: boolean }>
  intakeUrl: string
  intakeToken: string
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.length === 0) throw new Error(`model-governance: ${field} must be a non-empty string`)
  return value
}

/** Load and fail closed on a missing or malformed deployment policy. */
export function loadPolicy(filename: string): GovernancePolicyFile {
  let raw: unknown
  try { raw = JSON.parse(readFileSync(filename, 'utf8')) } catch (error) {
    throw new Error(`model-governance: cannot load policy ${filename}: ${String(error)}`)
  }
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('model-governance: policy must be an object')
  const input = raw as Record<string, unknown>
  if (!Number.isSafeInteger(input.version) || Number(input.version) < 0) throw new Error('model-governance: version must be a non-negative integer')
  if (typeof input.defaultAllowed !== 'boolean' || !Array.isArray(input.models)) throw new Error('model-governance: invalid policy defaults')
  if (typeof input.userDeclaredAllowed !== 'boolean') throw new Error('model-governance: userDeclaredAllowed must be boolean')
  const seen = new Set<string>()
  const models = input.models.map((entry, index) => {
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) throw new Error(`model-governance: models[${index}] must be an object`)
    const row = entry as Record<string, unknown>
    const provider = requiredString(row.provider, `models[${index}].provider`)
    const model = requiredString(row.model, `models[${index}].model`)
    if (typeof row.allowed !== 'boolean') throw new Error(`model-governance: models[${index}].allowed must be boolean`)
    const key = `${provider}\0${model}`
    if (seen.has(key)) throw new Error(`model-governance: duplicate route ${provider}/${model}`)
    seen.add(key)
    return { provider, model, allowed: row.allowed }
  })
  return {
    version: Number(input.version), defaultAllowed: input.defaultAllowed,
    userDeclaredAllowed: input.userDeclaredAllowed, models,
    intakeUrl: requiredString(input.intakeUrl, 'intakeUrl'), intakeToken: requiredString(input.intakeToken, 'intakeToken'),
  }
}
