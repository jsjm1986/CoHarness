/** Browser-local route constants for the optional desktop opener. */
export const OPEN_IN_APP_APPS_ROUTE = '/open-in-app/apps'
/** Prefix for cached application icons. */
export const OPEN_IN_APP_ICON_PREFIX = '/open-in-app/icon'
/** Route used to launch a trusted local application. */
export const OPEN_IN_APP_OPEN_ROUTE = '/open-in-app/open'

/** Available local applications returned by the host. */
export interface OpenInAppAppsPayload { readonly apps: readonly string[] }
/** Request to open a workspace path in a local application. */
export interface OpenInAppOpenPayload { readonly app: string; readonly path: string }
