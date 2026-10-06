/** Shared desktop openers used by the local GUI carrier. */
export {
  canOpenNativePath,
  nativeFileApplications,
  nativeFileManager,
  openNativeAssociatedPath,
  openNativeFileApplication,
  openNativePath,
  openNativeTextFile,
  revealNativePath,
} from '@deepseek-ai/dsh-native-command'
export type {
  NativeFileApplication,
  NativeFileManager,
  PathOpenerInternals,
  PathOpenerRunner,
} from '@deepseek-ai/dsh-native-command'
