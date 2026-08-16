/** Message used when a live policy reload has left the provider fail-closed. */
export const POLICY_UNAVAILABLE_REASON = 'Model authorization is temporarily unavailable; requests are blocked until a valid policy is loaded.';
/**
 * Stable model-access service whose immutable decision snapshot can be replaced
 * without replacing the Cordis service object consumed by other plugins.
 */
export class ReloadableModelAccess {
    userDeclared;
    snapshot;
    /**
     * @param policy - the policy that was validated during plugin activation.
     * @param userDeclared - the live user-declared provider lookup.
     */
    constructor(policy, userDeclared) {
        this.userDeclared = userDeclared;
        this.snapshot = createSnapshot(policy);
    }
    /**
     * Replace the whole decision snapshot after a validated policy reload.
     * @param policy - the newly validated policy.
     */
    replace(policy) {
        this.snapshot = createSnapshot(policy);
    }
    /** Enter fail-closed mode until a valid policy is published. */
    unavailable() {
        this.snapshot = {
            defaultAllowed: false,
            userDeclaredAllowed: false,
            routes: new Map(),
            unavailable: true,
        };
    }
    /**
     * Decide whether a provider/model route is currently authorized. A route the
     * policy catalog lists always follows its entry, so a denial cannot be
     * overturned by a user-layer declaration; an unlisted route is authorized
     * only when the policy admits user-declared routes and the user layer
     * declares the provider; anything else falls back to `defaultAllowed`.
     * @param target - provider and model route to check.
     * @returns an allow or deny decision for the current immutable snapshot.
     */
    decide(target) {
        const snapshot = this.snapshot;
        if (snapshot.unavailable)
            return { allowed: false, reason: POLICY_UNAVAILABLE_REASON };
        const key = `${target.provider}\0${target.model}`;
        const allowed = snapshot.routes.has(key)
            ? snapshot.routes.get(key) === true
            : (snapshot.userDeclaredAllowed && this.userDeclared.has(target.provider)) || snapshot.defaultAllowed;
        return allowed ? { allowed: true } : {
            allowed: false,
            reason: `Model "${target.provider}/${target.model}" is not authorized for this account.`,
        };
    }
}
function createSnapshot(policy) {
    return {
        defaultAllowed: policy.defaultAllowed,
        userDeclaredAllowed: policy.userDeclaredAllowed,
        routes: new Map(policy.models.map(entry => [`${entry.provider}\0${entry.model}`, entry.allowed])),
        unavailable: false,
    };
}
