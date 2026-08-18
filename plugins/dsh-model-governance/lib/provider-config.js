import ModelProviderConfig from '@deepseek-ai/dsh-model-provider-config';
function deepFreeze(value, seen = new WeakSet()) {
    if (value === null || typeof value !== 'object' || seen.has(value))
        return value;
    seen.add(value);
    for (const nested of Object.values(value))
        deepFreeze(nested, seen);
    return Object.freeze(value);
}
function copySnapshot(snapshot) {
    return deepFreeze(structuredClone(snapshot));
}
/** Reloadable organization Provider configuration published by the projection plugin. */
export class ReloadableModelProviderConfig extends ModelProviderConfig {
    current;
    constructor(ctx, initial) {
        super(ctx);
        this.current = copySnapshot(initial);
    }
    /** @inheritdoc */
    snapshot() {
        return this.current;
    }
    /** Commit one active Provider set, then notify adapter Consumers. */
    replace(next) {
        this.current = copySnapshot(next);
        this.ctx.emit('model-provider-config/updated', this.current.revision);
    }
}
/** Union current and next routes so additions register before authorization changes. */
export function stagedProviderSnapshot(current, next) {
    const providers = new Map(current.providers.map(provider => [provider.provider, provider]));
    for (const provider of next.providers)
        providers.set(provider.provider, provider);
    return { revision: next.revision, providers: [...providers.values()] };
}
