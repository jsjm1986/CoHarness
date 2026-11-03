/** Capture readable, path-stable workspace state for recorded-session tests. */
import { mkdir, readFile, readdir, readlink, rm, symlink, writeFile } from 'node:fs/promises';
import { dirname, join, sep } from 'node:path';
/** Marker that lets Git retain an expected empty directory without becoming expected workspace state. */
export const EMPTY_WORKSPACE_MARKER = '.empty';
function textContent(bytes) {
    if (bytes.includes(0))
        return undefined;
    const text = bytes.toString('utf8');
    return Buffer.from(text, 'utf8').equals(bytes) ? text : undefined;
}
/**
 * Capture one workspace without resolving links or depending on host path separators.
 * @param root - Absolute directory whose user-visible state is captured.
 * @param options - Harness-owned immediate children to omit.
 * @returns Stable entries sorted by relative path.
 */
export async function captureWorkspaceSnapshot(root, options = {}) {
    const ignoredRootEntries = new Set(options.ignoredRootEntries ?? []);
    const visit = async (directory, segments) => {
        const entries = (await readdir(directory, { withFileTypes: true }))
            .filter(entry => segments.length > 0 || !ignoredRootEntries.has(entry.name))
            .sort((left, right) => Buffer.compare(Buffer.from(left.name), Buffer.from(right.name)));
        const captured = [];
        for (const entry of entries) {
            const childSegments = [...segments, entry.name];
            const path = childSegments.join('/');
            const absolute = join(directory, entry.name);
            if (entry.isDirectory()) {
                const children = await visit(absolute, childSegments);
                captured.push(...children.length === 0 ? [{ path, kind: 'empty-directory' }] : children);
            }
            else if (entry.isFile()) {
                const bytes = await readFile(absolute);
                const content = textContent(bytes);
                captured.push(content === undefined
                    ? { path, kind: 'binary', base64: bytes.toString('base64') }
                    : { path, kind: 'text', content });
            }
            else {
                // Windows reports dir-link targets with backslashes; keep the stored
                // entry on the same POSIX separators `path` uses.
                captured.push({ path, kind: 'symlink', target: (await readlink(absolute)).replaceAll(sep, '/') });
            }
        }
        return captured;
    };
    return visit(root, []);
}
/**
 * Capture a committed `workspace.expected/` tree, excluding its Git-only empty marker.
 * @param root - Absolute expected-workspace directory.
 * @returns Stable expected entries.
 */
export function captureExpectedWorkspaceSnapshot(root) {
    return captureWorkspaceSnapshot(root, { ignoredRootEntries: [EMPTY_WORKSPACE_MARKER] });
}
/**
 * Replace one `workspace.expected/` tree with captured entries, marking an
 * empty expected workspace so Git retains the directory.
 *
 * @param root - Expected-workspace directory to rewrite.
 * @param entries - Captured workspace state.
 * @returns Resolves after the tree matches `entries`.
 */
export async function materializeWorkspaceSnapshot(root, entries) {
    await rm(root, { recursive: true, force: true });
    await mkdir(root, { recursive: true });
    if (entries.length === 0) {
        await writeFile(join(root, EMPTY_WORKSPACE_MARKER), '');
        return;
    }
    for (const entry of entries) {
        const absolute = join(root, ...entry.path.split('/'));
        switch (entry.kind) {
            case 'empty-directory':
                await mkdir(absolute, { recursive: true });
                break;
            case 'text':
                await mkdir(dirname(absolute), { recursive: true });
                await writeFile(absolute, entry.content);
                break;
            case 'binary':
                await mkdir(dirname(absolute), { recursive: true });
                await writeFile(absolute, Buffer.from(entry.base64, 'base64'));
                break;
            case 'symlink':
                await mkdir(dirname(absolute), { recursive: true });
                await symlink(entry.target, absolute);
                break;
        }
    }
}
//# sourceMappingURL=workspace.js.map