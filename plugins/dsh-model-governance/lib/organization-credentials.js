function record(value) {
    return typeof value === 'object' && value !== null && !Array.isArray(value)
        ? value
        : undefined;
}
function organizationCredentialResponse(value) {
    const response = record(value);
    if (response?.configured === false && response.value === undefined)
        return { configured: false };
    if (response?.configured === true && typeof response.value === 'string' && response.value.length > 0) {
        return { configured: true, value: response.value };
    }
    throw new Error('model-governance: invalid organization credential response');
}
/** Gateway-backed read-only credentials named by the active managed Provider snapshot. */
export class OrganizationCredentialLayer {
    gateway;
    providers;
    id = 'managed-model-providers';
    constructor(gateway, providers) {
        this.gateway = gateway;
        this.providers = providers;
    }
    /** @inheritdoc */
    owns(ref) {
        return this.providers.snapshot().providers.some(provider => provider.credentialRef === ref);
    }
    /** @inheritdoc */
    async resolve(ref) {
        const credential = await this.fetch(ref);
        return credential.configured
            ? { value: credential.value, source: this.sourceOf(ref) }
            : undefined;
    }
    /** @inheritdoc */
    async describe(ref) {
        const credential = await this.fetch(ref);
        return {
            configured: credential.configured,
            ...credential.configured ? { source: this.sourceOf(ref) } : {},
            writable: false,
        };
    }
    async fetch(ref) {
        if (!this.owns(ref)) {
            throw new Error(`model-governance: credential reference "${ref}" is not owned by a managed Provider`);
        }
        const response = await this.gateway.request('/internal/runtime/model-credential', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ ref }),
        });
        if (!response.ok) {
            throw new Error(`model-governance: managed credential request failed with HTTP ${String(response.status)}`);
        }
        let value;
        try {
            value = await response.json();
        }
        catch {
            throw new Error('model-governance: managed credential response is not valid JSON');
        }
        return organizationCredentialResponse(value);
    }
    /** Return the source label used for usage attribution and UI diagnostics. */
    sourceOf(ref) {
        return String(ref).startsWith('DSH_PROJECT_') ? 'project' : 'organization';
    }
}
