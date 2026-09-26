/** Configuration entries supplied by the administrator surface to the shared manager page. */
export interface HostObservable<T> { getSnapshot(): T; subscribe(listener: () => void): () => void }
export interface OfficialItem { readonly id: string; readonly label: string }
export interface ConfigLedger { readonly items: readonly OfficialItem[]; readonly bundles: ReadonlySet<string>; readonly rows: ReadonlySet<string> }
/** Resolve one package row's registered configuration key. */
export function rowConfigKey(bundle: string, rowId: string): string { return `${bundle}#${rowId}` }
