import { createHash, randomUUID } from 'node:crypto';
const TRACKED_NAMESPACES = new Set(['llm-pi-ai', 'llm-deepseek']);
function objectOf(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value) ? value : undefined;
}
function stable(value) {
    if (Array.isArray(value))
        return `[${value.map(stable).join(',')}]`;
    if (value !== null && typeof value === 'object') {
        return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stable(value[key])}`).join(',')}}`;
    }
    return JSON.stringify(value) ?? 'null';
}
function modelSnapshot(value) {
    const object = objectOf(value);
    const id = typeof object?.id === 'string' ? object.id.trim() : '';
    if (id === '')
        return undefined;
    return { id, snapshot: { fingerprint: stable(object) } };
}
function profileSnapshot(value) {
    const profile = objectOf(value) ?? {};
    const models = {};
    const rawModels = Array.isArray(profile.models) ? profile.models : [];
    for (const raw of rawModels) {
        const model = modelSnapshot(raw);
        if (model !== undefined)
            models[model.id] = model.snapshot;
    }
    const withoutModels = {};
    for (const [key, entry] of Object.entries(profile)) {
        // Credential references and arbitrary provider headers are configuration
        // details, not registration identity; they never affect the audit action.
        if (key === 'models' || key === 'apiKeyEnv' || key === 'headers' || key === 'credential')
            continue;
        withoutModels[key] = entry;
    }
    return { fingerprint: stable(withoutModels), models };
}
/** Extract personal Provider/model identities from one settings namespace. */
export function registrationSnapshot(namespace, value) {
    if (!TRACKED_NAMESPACES.has(String(namespace)))
        return undefined;
    const root = objectOf(value);
    if (root === undefined)
        return {};
    if (String(namespace) === 'llm-deepseek') {
        return Object.keys(root).length === 0 ? {} : { 'deepseek-official': profileSnapshot(root) };
    }
    const providers = objectOf(root.providers);
    if (providers === undefined)
        return {};
    return Object.fromEntries(Object.entries(providers).map(([provider, profile]) => [provider, profileSnapshot(profile)]));
}
function event(occurredAt, provider, action, model, identity) {
    return {
        kind: 'model-registration',
        eventId: identity === undefined ? randomUUID() : `registration-${createHash('sha256').update(identity).digest('hex')}`,
        occurredAt, provider, action, scope: 'personal',
        ...model === undefined ? {} : { model },
    };
}
/** Create an idempotent baseline for identities already present in the user layer. */
export function baselineRegistrations(namespace, userLayer, occurredAt = Date.now()) {
    const snapshot = registrationSnapshot(namespace, userLayer);
    if (snapshot === undefined)
        return [];
    const result = [];
    for (const [provider, profile] of Object.entries(snapshot)) {
        result.push(event(occurredAt, provider, 'provider-created', undefined, `${namespace}\0provider\0${provider}\0${profile.fingerprint}`));
        for (const [model, details] of Object.entries(profile.models)) {
            result.push(event(occurredAt, provider, 'model-created', model, `${namespace}\0model\0${provider}\0${model}\0${details.fingerprint}`));
        }
    }
    return result;
}
/** Diff two committed settings values into non-secret semantic audit events. */
export function diffRegistrations(namespace, previous, next, occurredAt = Date.now()) {
    const before = registrationSnapshot(namespace, previous);
    const after = registrationSnapshot(namespace, next);
    if (before === undefined || after === undefined)
        return [];
    const result = [];
    const providers = new Set([...Object.keys(before), ...Object.keys(after)]);
    for (const provider of providers) {
        const oldProvider = before[provider];
        const newProvider = after[provider];
        if (oldProvider === undefined && newProvider !== undefined) {
            result.push(event(occurredAt, provider, 'provider-created', undefined, `${namespace}\0provider\0${provider}\0${newProvider.fingerprint}`));
            for (const [model, details] of Object.entries(newProvider.models)) {
                result.push(event(occurredAt, provider, 'model-created', model, `${namespace}\0model\0${provider}\0${model}\0${details.fingerprint}`));
            }
            continue;
        }
        if (oldProvider !== undefined && newProvider === undefined) {
            result.push(event(occurredAt, provider, 'provider-deleted'));
            for (const model of Object.keys(oldProvider.models))
                result.push(event(occurredAt, provider, 'model-deleted', model));
            continue;
        }
        if (oldProvider === undefined || newProvider === undefined)
            continue;
        if (oldProvider.fingerprint !== newProvider.fingerprint)
            result.push(event(occurredAt, provider, 'provider-modified'));
        const models = new Set([...Object.keys(oldProvider.models), ...Object.keys(newProvider.models)]);
        for (const model of models) {
            const beforeModel = oldProvider.models[model];
            const afterModel = newProvider.models[model];
            if (beforeModel === undefined && afterModel !== undefined)
                result.push(event(occurredAt, provider, 'model-created', model));
            else if (beforeModel !== undefined && afterModel === undefined)
                result.push(event(occurredAt, provider, 'model-deleted', model));
            else if (beforeModel !== undefined && afterModel !== undefined && beforeModel.fingerprint !== afterModel.fingerprint) {
                result.push(event(occurredAt, provider, 'model-modified', model));
            }
        }
    }
    return result;
}
