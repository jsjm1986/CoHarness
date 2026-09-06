import type { SessionFormatChain, SessionFormatChainOptions, SessionFormatMigration } from './types.ts'
/** Validate one exact adjacent migration declaration. */
export declare function defineSessionFormatMigration(migration: SessionFormatMigration): SessionFormatMigration
/** Compile a unique, complete adjacent migration chain. */
export declare function createSessionFormatChain(options: SessionFormatChainOptions): SessionFormatChain
//# sourceMappingURL=chain.d.ts.map
