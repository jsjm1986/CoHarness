import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
/** Read the repository key without printing its value. */
export function requireSnapshotRecordKey(environment = process.env) {
    const key = environment.DEEPSEEK_API_KEY;
    if (typeof key !== 'string' || key.length === 0) {
        throw new Error('snapshot record requires DEEPSEEK_API_KEY; use keyless replay or refresh when no key is available');
    }
}
/** Load the optional root env file and fail before any record scenario starts. */
export function snapshotRecordPreflight(environment = process.env) {
    if (environment.DEEPSEEK_API_KEY === undefined) {
        const envPath = resolve(import.meta.dirname, '..', '.env');
        if (existsSync(envPath)) {
            try {
                process.loadEnvFile(envPath);
            }
            catch (error) {
                throw new Error(`snapshot record could not load ${envPath}`, { cause: error });
            }
        }
    }
    requireSnapshotRecordKey(environment);
}
/**
 * Select explicit live Web verification without letting ambient credentials enable it.
 * @param environment - Requested browser lane and snapshot mode.
 * @returns Whether the real-provider browser lane was explicitly selected.
 */
export function webLiveRequested(environment = process.env) {
    const live = environment.DSH_WEB_LIVE;
    if (live === undefined || live === '')
        return false;
    if (live !== '1')
        throw new Error('DSH_WEB_LIVE must be 1 or unset');
    if (environment.DSH_SNAPSHOT !== undefined && environment.DSH_SNAPSHOT !== '') {
        throw new Error('live Web verification cannot run in a snapshot record, replay or refresh lane');
    }
    return true;
}
if (import.meta.main) {
    snapshotRecordPreflight();
    process.stdout.write('snapshot record preflight: DEEPSEEK_API_KEY is available\n');
}
//# sourceMappingURL=snapshot-preflight.js.map