// Ambient module faces for workspace modules whose sources do not compile
// under this project's strict flags. The `paths` map in tsconfig.json covers
// the workspace sources that do compile; only the merge targets needed by
// their module augmentations are declared here. tsconfig.build.json excludes
// this file, so production builds resolve the real packages through
// node_modules links and their emitted declarations. The file stays a script
// (no imports or exports) so each `declare module` below is an ambient module
// declaration rather than an augmentation that would itself need NodeNext
// resolution. Vendored Cordis needs no face: its emitted lib/types already
// export the `Events` interface the packages augment through `paths`.

declare module '@deepseek-ai/dsh-typert-protocol' {
  export interface RemoteErrorDetailsMap {}
}
