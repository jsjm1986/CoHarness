/** Real descriptor-relative directory behavior through the packaged JavaScript entry. */
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { once } from 'node:events';
import { fstatSync, readdirSync } from 'node:fs';
import { mkdir, mkdtemp, realpath, rename, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import test from 'node:test';
import { Worker } from 'node:worker_threads';
import { DirectoryHandle } from '../packages/entry/lib/directory.js';

const posix = process.platform === 'darwin' || process.platform === 'linux';
const options = { timeout: 20000, skip: posix ? false : 'POSIX directory descriptors require Linux or macOS' };

async function fixture(t) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'node-addon-system-directory-')));
  const handles = [];
  t.after(async () => {
    const closed = await Promise.allSettled(handles.map(handle => handle.close()));
    const failures = closed.filter(result => result.status === 'rejected').map(result => result.reason);
    try { await rm(root, { recursive: true, force: true }); } catch (error) { failures.push(error); }
    if (failures.length > 0) throw new AggregateError(failures, 'Directory fixture cleanup failed');
  });
  return { root, keep(handle) { handles.push(handle); return handle; } };
}

test('importing the directory entry does not load an addon', { timeout: 20000 }, async () => {
  const url = new URL('../packages/entry/lib/directory.js', import.meta.url).href;
  await promisify(execFile)(process.execPath, ['--no-addons', '--input-type=module', '-e', `await import(${JSON.stringify(url)});`]);
});

test('retains the opened directory after its path is replaced by a foreign link', options, async (t) => {
  const scope = await fixture(t), owned = join(scope.root, 'owned'), foreign = join(scope.root, 'foreign');
  await mkdir(owned); await mkdir(foreign);
  await mkdir(join(owned, 'permitted')); await mkdir(join(foreign, 'private'));
  const handle = scope.keep(await DirectoryHandle.open(owned));
  const info = await stat(owned, { bigint: true });
  assert.deepEqual(handle.identity, { device: info.dev, inode: info.ino });
  const retained = join(scope.root, 'retained');
  await rename(owned, retained); await symlink(foreign, owned);
  assert.deepEqual((await handle.read(10)).map(entry => entry.name), ['permitted']);
  await handle.createDirectory('created');
  assert.equal((await stat(join(retained, 'created'))).isDirectory(), true);
  await assert.rejects(stat(join(foreign, 'created')), { code: 'ENOENT' });
  await assert.rejects(DirectoryHandle.open(owned), error => ['ELOOP', 'ENOTDIR'].includes(error.code));
});

test('opens real children and refuses link, traversal, NUL and multi-segment children', options, async (t) => {
  const scope = await fixture(t);
  await mkdir(join(scope.root, 'child')); await symlink(join(scope.root, 'child'), join(scope.root, 'link'));
  const parent = scope.keep(await DirectoryHandle.open(scope.root));
  const child = scope.keep(await parent.openChild('child'));
  await child.createDirectory('nested');
  assert.equal((await stat(join(scope.root, 'child/nested'))).isDirectory(), true);
  await assert.rejects(parent.openChild('link'), error => ['ELOOP', 'ENOTDIR'].includes(error.code));
  for (const name of ['', '.', '..', 'child/nested', 'child\0suffix']) {
    await assert.rejects(parent.openChild(name));
    await assert.rejects(parent.createDirectory(name));
  }
  await assert.rejects(parent.createDirectory('child'), { code: 'EEXIST' });
  await assert.rejects(parent.openChild('missing'), { code: 'ENOENT' });
});

test('reads a retained filesystem identity without changing directory identity or permitting work after close', options, async (t) => {
  const scope = await fixture(t), original = join(scope.root, 'original'), moved = join(scope.root, 'moved');
  await mkdir(original);
  const handle = scope.keep(await DirectoryHandle.open(original)), before = handle.identity;
  const volume = await handle.volumeIdentity();
  if (process.platform === 'darwin') assert.match(volume, /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/);
  else assert.equal(volume, undefined);
  await rename(original, moved);
  await mkdir(original);
  assert.equal(await handle.volumeIdentity(), volume);
  assert.deepEqual(handle.identity, before);
  const pending = handle.volumeIdentity(), closing = handle.close();
  assert.equal(await pending, volume);
  await closing;
  await assert.rejects(handle.volumeIdentity(), { code: 'EBADF' });
});

test('streams bounded batches with entry types and stable EOF', options, async (t) => {
  const scope = await fixture(t);
  await mkdir(join(scope.root, 'directory'));
  await writeFile(join(scope.root, 'file'), 'contents');
  await symlink(join(scope.root, 'directory'), join(scope.root, 'link'));
  const parent = scope.keep(await DirectoryHandle.open(scope.root));
  const entries = [];
  for (;;) {
    const batch = await parent.read(1);
    assert.ok(batch.length <= 1);
    if (batch.length === 0) break;
    entries.push(...batch);
  }
  entries.sort((left, right) => left.name.localeCompare(right.name));
  assert.deepEqual(entries, [
    { name: 'directory', isDirectory: true, isSymbolicLink: false },
    { name: 'file', isDirectory: false, isSymbolicLink: false },
    { name: 'link', isDirectory: false, isSymbolicLink: true },
  ]);
  assert.deepEqual(await parent.read(2), []);
});

test('queues close after pending operations and rejects new work after close begins', options, async (t) => {
  const scope = await fixture(t), handle = scope.keep(await DirectoryHandle.open(scope.root));
  const creating = handle.createDirectory('queued');
  const reading = handle.read(10);
  const closing = handle.close();
  assert.equal(handle.close(), closing);
  await creating;
  assert.deepEqual((await reading).map(entry => entry.name), ['queued']);
  await closing;
  await assert.rejects(handle.read(1), { code: 'EBADF' });
  await assert.rejects(handle.createDirectory('late'), { code: 'EBADF' });
  await assert.rejects(stat(join(scope.root, 'late')), { code: 'ENOENT' });
});

test('rejects invalid read bounds and retains the handle for later valid work', options, async (t) => {
  const scope = await fixture(t), handle = scope.keep(await DirectoryHandle.open(scope.root));
  for (const count of [0, -1, 1.5, NaN, Infinity, 65537]) await assert.rejects(handle.read(count));
  assert.deepEqual(await handle.read(1), []);
  await assert.rejects(DirectoryHandle.open('relative'));
  await assert.rejects(DirectoryHandle.open(`${scope.root}\0suffix`));
});

function openedReferences(identity) {
  const directory = process.platform === 'linux' ? '/proc/self/fd' : '/dev/fd';
  return readdirSync(directory).filter(name => /^\d+$/.test(name)).filter(name => {
    try {
      const info = fstatSync(Number(name), { bigint: true });
      return info.dev === identity.dev && info.ino === identity.ino;
    } catch (error) {
      if (error.code === 'EBADF') return false;
      throw error;
    }
  });
}

for (const phase of ['queued', 'callback']) {
  test(`worker termination during ${phase} releases every directory descriptor it owns`, options, async (t) => {
    const scope = await fixture(t), identity = await stat(scope.root, { bigint: true });
    assert.deepEqual(openedReferences(identity), []);
    const worker = new Worker(new URL('./fixtures/directory-worker.js', import.meta.url), {
      workerData: { path: scope.root, phase }, execArgv: [],
    });
    t.after(() => worker.terminate());
    const exited = once(worker, 'exit'), waiting = new AbortController();
    try {
      const [message] = await Promise.race([
        once(worker, 'message', { signal: AbortSignal.any([t.signal, waiting.signal]) }),
        exited.then(([code]) => { throw new Error(`Directory worker exited before ${phase}: ${code}`); }),
      ]);
      assert.deepEqual(message, { type: phase, nativeWork: 1 });
      if (phase === 'callback') assert.equal(openedReferences(identity).length, 1);
    } finally { waiting.abort(); }
    assert.equal(await worker.terminate(), 1);
    await exited;
    assert.deepEqual(openedReferences(identity), []);
  });
}
