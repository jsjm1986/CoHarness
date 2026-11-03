/** Fetch-input projection shared by the account-request fixtures. */

/** Read the URL from each form accepted by Fetch.
 * @param input - the request value received by the fixture.
 * @returns its URL text.
 */
export function requestUrl(input: RequestInfo | URL | undefined): string {
  if (input === undefined) throw new Error('No Fetch request was captured')
  return typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
}
