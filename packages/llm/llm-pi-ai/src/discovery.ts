/**
 * Answering "which models can this provider serve?" for the configuration
 * surface's "fetch available models" action.
 *
 * A route the installed pi-ai catalog ships is answered **from that catalog**,
 * with no network call at all: pi-ai's registry is the authoritative list for
 * its own providers, and it carries the capacities a listing endpoint would
 * not disclose. Only a route the catalog does not describe — a gateway, a
 * self-hosted server — is interrogated over the wire.
 *
 * Neither path is a catalog refresh. Nothing here is stored: the request
 * carries a draft the user is still editing, and the reply is candidate
 * metadata the surface offers for adoption. `settings.yaml` remains the only
 * thing that decides what a route serves.
 *
 * OpenAI-compatible and Anthropic Messages protocols are interrogated through
 * their documented model-list endpoints and authentication headers. Every
 * other protocol reports that it cannot be interrogated so the surface falls
 * back to hand-entry rather than guessing a response format.
 *
 * @module dsh-llm-pi-ai/discovery
 */

import { discoverModelsAtEndpoint, LlmError, supportsModelListing } from '@deepseek-ai/dsh-llm'
import type { LlmDiscoveredModel, LlmEndpointResolutionCache, LlmModelDiscoveryRequest } from '@deepseek-ai/dsh-llm'
import { catalogModels } from './catalog.ts'

/** Host-owned profile inputs that a configuration draft deliberately omits. */
export interface StoredModelDiscoveryProfile {
  /** Deployment headers configured on the named route. */
  readonly headers: Readonly<Record<string, string>> | undefined
  /** Resolve the named route's credential only when the draft carries none. */
  readonly resolveApiKey: () => Promise<string | undefined>
}

/**
 * Interrogate one draft provider endpoint for the models it advertises.
 * @param request - the endpoint, protocol, and one-shot credential to use.
 * @param storedProfile - Host-owned headers and lazy credential resolution for
 *   the named route. It is read only on the path that reaches the network; the
 *   credential is resolved only when the draft carries none. A configuration
 *   surface edits a redacted descriptor and holds neither, so without this an
 *   already-configured route would be interrogated unauthenticated.
 * @param cache - optional process-local endpoint resolution cache shared with
 *   model requests; a successful candidate is retained until the profile
 *   snapshot changes.
 * @returns the advertised models in endpoint order.
 * @throws LlmError when the protocol has no readable listing, the endpoint
 *   refuses or fails the request, or the reply is not a model listing.
 */
export async function discoverModels(
  request: LlmModelDiscoveryRequest,
  storedProfile?: () => StoredModelDiscoveryProfile | undefined,
  cache?: LlmEndpointResolutionCache,
): Promise<readonly LlmDiscoveredModel[]> {
  // A catalog route already has its answer, and a better one: the installed
  // entries carry context windows and output caps no listing endpoint reports.
  if (request.provider !== undefined) {
    const installed = catalogModels(request.provider)
    if (installed.size > 0) {
      return [...installed.values()].map(model => ({
        id: model.id,
        name: model.name,
        contextWindow: model.contextWindow,
        maxTokens: model.maxTokens,
        inputModalities: [...model.input],
      }))
    }
  }
  if (request.baseURL === undefined || request.baseURL.length === 0) {
    throw new LlmError(
      `pi-ai ships no catalog for provider "${request.provider ?? ''}", so its models can only come from its`
      + " endpoint; set a baseURL, or enter this provider's models by hand",
      'DISCOVERY_FAILED',
    )
  }
  // Keep the stored-key lookup below out of unsupported protocols. The shared
  // helper owns the protocol set; this guard only preserves pi-ai's catalog
  // and credential ordering for its settings surface.
  const api = request.api ?? 'openai-completions'
  if (!supportsModelListing(api)) {
    throw new LlmError(
      `pi-ai protocol "${api}" has no model listing this build can read; enter this provider's models by hand`,
      'DISCOVERY_UNSUPPORTED',
    )
  }
  // A key typed into the form wins: it may replace the stored key that is
  // failing. The stored profile is asked only here, past the catalog
  // short-circuit and the protocol check, and its credential resolver stays
  // lazy so a typed key cannot fail over a stored credential it supersedes. A
  // probe carrying no key stays unauthenticated — how a route relying on the
  // provider's own ambient discovery is meant to be asked — unless a
  // deployment-owned Authorization header on the profile authenticates it.
  const stored = storedProfile?.()
  const supplied = request.apiKey ?? await stored?.resolveApiKey()
  return discoverModelsAtEndpoint({
    baseURL: request.baseURL,
    api,
    ...(supplied === undefined ? {} : { apiKey: supplied }),
    ...(stored?.headers === undefined ? {} : { headers: stored.headers }),
    ...(request.signal === undefined ? {} : { signal: request.signal }),
  }, cache)
}
