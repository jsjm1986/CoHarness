/** Read the repository key without printing its value. */
export declare function requireSnapshotRecordKey(environment?: NodeJS.ProcessEnv): void;
/** Load the optional root env file and fail before any record scenario starts. */
export declare function snapshotRecordPreflight(environment?: NodeJS.ProcessEnv): void;
/**
 * Select explicit live Web verification without letting ambient credentials enable it.
 * @param environment - Requested browser lane and snapshot mode.
 * @returns Whether the real-provider browser lane was explicitly selected.
 */
export declare function webLiveRequested(environment?: NodeJS.ProcessEnv): boolean;
//# sourceMappingURL=snapshot-preflight.d.ts.map