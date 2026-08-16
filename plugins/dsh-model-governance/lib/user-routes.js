/** Read the plain-object node at `path` inside a settings user layer. */
function nodeAt(root, path) {
    let current = root;
    for (const segment of path) {
        if (typeof current !== 'object' || current === null || Array.isArray(current))
            return undefined;
        current = current[segment];
    }
    return current;
}
/**
 * Compute the provider routes this instance's settings user layer declares.
 * One configurable-provider directory entry is judged against the descriptor
 * of the namespace that owns it: presence in the descriptor's `user` layer at
 * the entry's settings path is the settings seam's own mark of a user
 * override, so it covers both a hand-declared route and a shipped route the
 * user configured (typically by storing a personal key). The composition
 * `base` layer never counts, keeping deployment-mounted providers inside the
 * catalog's authority.
 * @param llm - the adapter registry owning the configurable-provider directory.
 * @param settings - the settings service holding the namespace descriptors.
 * @returns the declared provider ids; a route with no directory entry is absent.
 */
export function userDeclaredProviders(llm, settings) {
    const userLayers = new Map(settings.describe().map(descriptor => [descriptor.ns, descriptor.user]));
    const declared = new Set();
    for (const entry of llm.listConfigurableProviders()) {
        const user = userLayers.get(entry.settingsNs);
        if (typeof user !== 'object' || user === null || Array.isArray(user))
            continue;
        const section = user;
        const present = entry.settingsPath.length === 0
            ? Object.keys(section).length > 0
            : nodeAt(section, entry.settingsPath) !== undefined;
        if (present)
            declared.add(entry.provider);
    }
    return declared;
}
/**
 * Mutable owner of the user-declared provider set. Refreshed from registry
 * and settings events, read synchronously by the model-access decision, and
 * cleared when no settings service backs the facts.
 */
export class UserDeclaredRoutes {
    providers = new Set();
    /**
     * Recompute the set from the current directory and user layers.
     * @param llm - the adapter registry owning the configurable-provider directory.
     * @param settings - the settings service holding the namespace descriptors.
     */
    refresh(llm, settings) {
        this.providers = userDeclaredProviders(llm, settings);
    }
    /** Drop every fact; nothing is user-declared until a refresh supplies facts. */
    clear() {
        this.providers = new Set();
    }
    /**
     * Whether the user layer declares this provider route.
     * @param provider - provider route id.
     * @returns whether the settings user layer carries this route's profile.
     */
    has(provider) {
        return this.providers.has(provider);
    }
}
