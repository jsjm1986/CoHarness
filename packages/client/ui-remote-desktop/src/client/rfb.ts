/** Unwrap the noVNC RFB class across the two CommonJS interop faces. */
import * as rfbModule from '@novnc/novnc/lib/rfb.js'

/** The published transpile assigns the class to `module.exports.default`;
 * module runtimes surface it either directly as the namespace default or
 * nested one level deeper under that default. */
const nested = rfbModule.default as unknown as { default?: typeof rfbModule.default }
export const RFB: typeof rfbModule.default = nested.default ?? rfbModule.default
