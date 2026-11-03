/**
 * Exclude ambient credentials from replay while retaining scenario-owned overrides.
 * @param mode - Explicit snapshot mode; undefined is an ordinary live integration launch.
 * @param overrides - Controlled scenario configuration and source-loader settings.
 * @param parent - Parent environment; defaults to the launching process.
 * @returns Complete child environment suitable for spawn without implicit inheritance.
 */
export declare function snapshotChildEnvironment(
  mode: string | undefined, overrides: NodeJS.ProcessEnv, parent?: NodeJS.ProcessEnv,
): NodeJS.ProcessEnv
//# sourceMappingURL=environment.d.ts.map
