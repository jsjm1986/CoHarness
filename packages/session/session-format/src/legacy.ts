/** Transitional legacy catalog API for consumers not yet on codec/restore reads. */

export * from './legacy-types.ts'
export * from './legacy-json.ts'
export { createSessionFormatCatalog } from './legacy-catalog.ts'
export { createSessionFormatChain, defineSessionFormatMigration } from './legacy-chain.ts'
export { sessionFormatCatalog } from './catalog-default.ts'
