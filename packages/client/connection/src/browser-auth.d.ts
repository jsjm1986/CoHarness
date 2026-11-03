/** Browser-session authentication for the Host Connection carrier. */
import type { CredentialProvider } from '@deepseek-ai/dsh-credentials'
import { type ConnectionInteractions } from '@deepseek-ai/dsh-host-apiproxy/api/interactions'
import type { ConnectionIndexRequest, ConnectionIndexResponse, ConnectionTrustRequest } from './rpc.ts'
/**
 * Process launch-token exchange and persistent signed-cookie verification.
 * Connection loads the credential provider's signing secret during activation
 * and retains it for synchronous request authentication.
 */
export declare class BrowserAuth {
  private readonly secret
  private readonly launchToken
  private readonly maxAgeMilliseconds
  private constructor()
  /**
     * Initialize browser authentication and create its durable signing secret
     * when this Harness home has none.
     * @param processOwner - root application context retaining one token across Connection reloads.
     * @param credentials - persistent credential provider for the Web profile.
     * @param maxAgeDays - positive absolute browser-cookie lifetime in days.
     * @returns initialized authentication owner with the process owner's launch token.
     */
  static create(processOwner: object, credentials: CredentialProvider, maxAgeDays: number): Promise<BrowserAuth>
  /**
     * Add this process's launch token to the caller's application URL.
     * @param baseUrl - clean browser URL whose authority and mount are preserved.
     * @returns the same URL carrying the process token as its sole authentication input.
     */
  authenticatedUrl(baseUrl: string): string
  /**
     * Authenticate an index request. A valid root query token mints the cookie
     * and redirects to the directory-relative clean `./`; a valid cookie lets
     * the caller serve the index; every other request receives the same minimal
     * 401 response.
     * @param req - incoming root or configured-index request.
     * @param res - response owned when this method returns false.
     * @param provider - a deployment provider's decision, when one answered:
     *   `false` writes the ordinary 401 before any token exchange and `true`
     *   admits without minting a cookie; `undefined` keeps token/cookie behavior.
     * @param secure - whether the listener receiving this request serves TLS; the
     *   minted cookie carries `Secure` when it does. Only that listener's own
     *   protocol decides, never a `publicUrl` announcement or a forwarded header:
     *   those describe a hop this process does not terminate.
     * @returns true only when the caller may serve index.html.
     */
  authorizeIndex(req: ConnectionIndexRequest, res: ConnectionIndexResponse, provider?: boolean, secure?: boolean): boolean
  /**
     * Verify a non-cookie operator credential: the process launch token
     * presented as an `Authorization: Bearer` header or the `?token=` query of
     * the request URL — the same credential the index exchange redeems, held
     * by programmatic connections that never mint a cookie — plus the optional
     * `x-dsh-interactions`/`?interactions=` mode declaration.
     * @param request - request headers and URL.
     * @returns the declared mode or 'none' when the credential is valid,
     *   'invalid' for a mismatched token or a malformed mode declaration, or
     *   undefined when no operator credential is present.
     */
  operatorInteractions(request: ConnectionIndexRequest): ConnectionInteractions | 'invalid' | undefined
  /**
     * Resolve the interaction scope one admitted request binds: a valid
     * declared mode wins; otherwise a valid operator credential defaults to
     * 'none' and every other request keeps the historical full 'answer'
     * participation.
     * @param request - accepted request headers and URL.
     * @returns the mode the request scope binds for this dispatch.
     */
  scopeInteractions(request: ConnectionIndexRequest): ConnectionInteractions
  /**
     * Verify the authority-bound browser cookie on a Host request.
     * @param request - request headers carrying Host and Cookie.
     * @param secure - whether the receiving listener uses TLS, including its default port.
     * @returns true only for an unexpired cookie signed by this activation's loaded secret.
     */
  isAuthenticated(request: ConnectionTrustRequest, secure?: boolean): boolean
  private writeUnauthorized
}
//# sourceMappingURL=browser-auth.d.ts.map
