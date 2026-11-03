/** Real native-call interleaving owned exclusively by one deterministic filesystem scenario. */
/**
 * Forward real FFI calls around a caller-owned filesystem mutation, restoring the loader afterwards.
 * @param beforeRename - operation awaited immediately before each native directory rename.
 * @param operation - exclusive owner of the process-wide wrapper until completion.
 * @returns the operation result after exact loader restoration.
 */
export function withDirectoryRenameInterleave<T>(
  beforeRename: (source: string, target: string) => Promise<void>, operation: () => Promise<T>,
): Promise<T>
