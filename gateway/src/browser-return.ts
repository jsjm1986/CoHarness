/** Preserve a browser's workbench or Admin destination through account gates. */

/**
 * Accept local UI addresses without introducing a redirect to another origin or an API action.
 * @param value - untrusted request or form destination.
 * @returns the normalized local UI address, or the environment entry page.
 */
export function browserReturnPath(value: string | null | undefined): string {
  if (value === undefined || value === null || !value.startsWith('/') || value.startsWith('//') || /[\\\u0000-\u0020\u007f]/u.test(value)) return '/'
  const url = new URL(value, 'http://gateway.invalid')
  if (url.origin !== 'http://gateway.invalid' || url.pathname !== '/' && !/^\/admin(?:\/|$)/u.test(url.pathname)
    || /^\/admin\/api(?:\/|$)/u.test(url.pathname)) return '/'
  return `${url.pathname}${url.search}${url.hash}`
}
