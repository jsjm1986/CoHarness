/** Suspend before or inside native completion while the parent verifies environment cleanup. */
import assert from 'node:assert/strict';
import { createHook } from 'node:async_hooks';
import { parentPort, workerData } from 'node:worker_threads';
import { DirectoryHandle } from '../../packages/entry/lib/directory.js';
import { loadFlockBinding } from './flock-binding.js';

let nativeWork = 0;
const hook = createHook({ init(_id, type) { if (type === 'directory') nativeWork++; } });
hook.enable();
try {
  if (workerData.phase === 'callback') {
    loadFlockBinding().directoryOpen(workerData.path, (errno) => {
      assert.equal(errno, 0);
      parentPort.postMessage({ type: 'callback', nativeWork });
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
    });
  } else {
    const opening = DirectoryHandle.open(workerData.path);
    assert.equal(nativeWork, 1);
    parentPort.postMessage({ type: 'queued', nativeWork });
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
    await opening;
  }
} finally { hook.disable(); }
