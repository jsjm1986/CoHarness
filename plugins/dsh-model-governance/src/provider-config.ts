import type { Context } from '@deepseek-ai/cordis'
import ModelProviderConfig from '@deepseek-ai/dsh-model-provider-config'
import type {
  ModelProviderConfigSnapshot,
} from '@deepseek-ai/dsh-model-provider-config'

function deepFreeze<T>(value: T, seen = new WeakSet<object>()): T {
  if (value === null || typeof value !== 'object' || seen.has(value)) return value
  seen.add(value)
  for (const nested of Object.values(value)) deepFreeze(nested, seen)
  return Object.freeze(value)
}

function copySnapshot(snapshot: ModelProviderConfigSnapshot): ModelProviderConfigSnapshot {
  return deepFreeze(structuredClone(snapshot))
}

/** Reloadable organization Provider configuration published by the projection plugin. */
export class ReloadableModelProviderConfig extends ModelProviderConfig {
  private current: ModelProviderConfigSnapshot

  constructor(ctx: Context, initial: ModelProviderConfigSnapshot) {
    super(ctx)
    this.current = copySnapshot(initial)
  }

  /** @inheritdoc */
  snapshot(): ModelProviderConfigSnapshot {
    return this.current
  }

  /** Commit one active Provider set, then notify adapter Consumers. */
  replace(next: ModelProviderConfigSnapshot): void {
    this.current = copySnapshot(next)
    this.ctx.emit('model-provider-config/updated', this.current.revision)
  }
}

/** Union current and next routes so additions register before authorization changes. */
export function stagedProviderSnapshot(
  current: ModelProviderConfigSnapshot,
  next: ModelProviderConfigSnapshot,
): ModelProviderConfigSnapshot {
  const providers = new Map(current.providers.map(provider => [provider.provider, provider]))
  for (const provider of next.providers) providers.set(provider.provider, provider)
  return { revision: next.revision, providers: [...providers.values()] }
}
