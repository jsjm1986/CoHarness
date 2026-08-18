import { randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { ReloadableModelAccess } from "./access.js";
import { UsageOutbox } from "./outbox.js";
import { OrganizationCredentialLayer } from "./organization-credentials.js";
import { loadPolicy } from "./policy.js";
import { ReloadableModelProviderConfig, stagedProviderSnapshot } from "./provider-config.js";
import { PolicyReloader } from "./reload.js";
import { UserDeclaredRoutes } from "./user-routes.js";
export const name = 'dsh-model-governance';
export const inject = ['llm'];
function credentialClass(source) {
    if (source === 'file' || source === 'project-env' || source === 'request')
        return 'personal';
    if (source === 'organization' || source === 'env' || source === 'process' || source === 'user-env')
        return 'company';
    return 'unknown';
}
function terminalStatus(chunk) {
    return chunk.reason.kind === 'error' ? 'failed' : chunk.reason.kind === 'aborted' ? 'cancelled' : 'succeeded';
}
/** Mount policy provider plus final llm/stream enforcement and metering. */
export function apply(ctx) {
    const home = process.env.DSH_HOME ?? join(homedir(), '.dsh');
    const policyPath = process.env.DSH_MODEL_GOVERNANCE ?? join(home, 'model-governance.json');
    const policy = loadPolicy(policyPath);
    const userDeclared = new UserDeclaredRoutes();
    const access = new ReloadableModelAccess(policy, userDeclared);
    const providerConfig = new ReloadableModelProviderConfig(ctx, {
        revision: policy.version,
        providers: policy.providers,
    });
    ctx.provide('modelAccess', access);
    ctx.inject(['credentials', 'gatewayRuntime', 'modelProviderConfig'], (sctx) => {
        const layer = new OrganizationCredentialLayer(sctx.gatewayRuntime, sctx.modelProviderConfig);
        sctx.effect(() => sctx.credentials.registerReadOnlyLayer(layer), 'model-governance: organization Provider credentials');
    });
    // Registry topology changes introduce or withdraw configurable providers;
    // recompute the user-declared set whenever the directory or route set moves.
    ctx.on('llm/adapters-updated', () => {
        const settings = ctx.get('settings');
        if (settings === undefined) {
            userDeclared.clear();
            return;
        }
        userDeclared.refresh(ctx.llm, settings);
    });
    // The raw user layer can change without moving any route (a shipped
    // provider gaining its first stored key), so the document event refreshes
    // the set as well; the scoped fiber releases the subscription and the facts
    // when the settings service goes away.
    ctx.inject(['settings'], (sctx) => {
        sctx.on('settings/document-updated', () => userDeclared.refresh(ctx.llm, sctx.settings));
        userDeclared.refresh(ctx.llm, sctx.settings);
        sctx.effect(() => () => userDeclared.clear());
    });
    const outbox = new UsageOutbox(join(home, 'model-governance-outbox'), policy.intakeUrl, policy.intakeToken);
    let reloader;
    ctx.effect(() => async () => {
        await reloader?.close();
        await outbox.close();
    }, 'model-governance: drain policy reload and usage outbox');
    reloader = new PolicyReloader({
        filename: policyPath,
        onValid: next => {
            providerConfig.replace(stagedProviderSnapshot(providerConfig.snapshot(), {
                revision: next.version,
                providers: next.providers,
            }));
            access.replace(next);
            providerConfig.replace({ revision: next.version, providers: next.providers });
            outbox.setEndpoint(next.intakeUrl, next.intakeToken);
        },
        onInvalid: error => {
            access.unavailable();
            ctx.logger.warn(`model-governance: policy reload failed at ${policyPath}; denying new model requests`);
            ctx.logger.warn(error);
        },
        onWatcherError: error => {
            ctx.logger.warn(`model-governance: policy watcher failed at ${policyPath}`);
            ctx.logger.warn(error);
        },
    });
    const enqueue = (record) => {
        try {
            outbox.enqueue(record);
        }
        catch (error) {
            ctx.logger.warn('model-governance: failed to persist usage record; model result is preserved');
            ctx.logger.warn(error);
        }
    };
    ctx.on('llm/stream', (options, next) => {
        const initiatorId = ctx.get('agents')?.currentInitiator()?.session.id;
        const explicitId = options.sessionId;
        const attributedId = explicitId ?? initiatorId;
        const base = {
            eventId: randomUUID(), occurredAt: Date.now(), provider: options.provider, model: options.model,
            purpose: options.purpose ?? 'assistant', ...attributedId === undefined ? {} : { sessionId: String(attributedId) },
        };
        if (initiatorId !== undefined && explicitId !== undefined && initiatorId !== explicitId) {
            return (async function* () {
                enqueue({ ...base, credentialSource: 'none', credentialClass: 'unknown', status: 'failed' });
                yield { type: 'finish', reason: { kind: 'error', failure: {
                            message: 'model-governance: initiating Agent and explicit sessionId disagree', code: 'MODEL_ATTRIBUTION_CONFLICT',
                        } } };
            })();
        }
        const decision = access.decide({ provider: options.provider, model: options.model });
        if (!decision.allowed)
            return (async function* () {
                enqueue({ ...base, credentialSource: 'none', credentialClass: 'unknown', status: 'denied' });
                yield { type: 'finish', reason: { kind: 'error', failure: { message: decision.reason, code: 'MODEL_FORBIDDEN' } } };
            })();
        return (async function* () {
            let usage;
            let source = 'unknown';
            let status = 'cancelled';
            try {
                for await (const chunk of next()) {
                    if (chunk.type === 'usage') {
                        usage = chunk.usage;
                        source = chunk.credentialSource ?? 'unknown';
                    }
                    if (chunk.type === 'finish')
                        status = terminalStatus(chunk);
                    yield chunk;
                }
            }
            finally {
                enqueue({
                    ...base, credentialSource: source, credentialClass: credentialClass(source),
                    status: status === 'succeeded' && usage === undefined ? 'missing-usage' : status,
                    ...usage === undefined ? {} : { usage },
                });
            }
        })();
    });
}
