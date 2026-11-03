/** Public Landlock probe closes a real SIGTERM-ignoring child at its configured deadline. */
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';

assert.notEqual(process.platform, 'win32');
const root = await mkdtemp(join(tmpdir(), 'nalr-probe-deadline-'));
let pending, marker, timer, primaryError;
async function endpoint(release = false) {
  try { return await (await fetch(`${marker.url}/${release ? 'release/' : ''}${marker.token}`, { signal: AbortSignal.timeout(1000), headers: { connection: 'close' } })).text(); }
  catch (error) { if (['ECONNREFUSED', 'ECONNRESET'].includes(error.cause?.code)) return undefined; throw error; }
}
try {
  const client = join(root, 'probe.mjs');
  await writeFile(client, `#!${process.execPath}
import { createServer } from 'node:http';
import { renameSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
process.on('SIGTERM', () => {});
const token = randomUUID(), server = createServer((request, response) => {
  if (request.url === '/release/' + token) { response.end('released'); server.close(() => process.exit(1)); }
  else response.end(request.url === '/' + token ? token : 'unknown');
});
server.listen(0, '127.0.0.1', () => {
  const temporary = ${JSON.stringify(join(root, 'ready-'))} + token;
  writeFileSync(temporary, JSON.stringify({ url: 'http://127.0.0.1:' + server.address().port, token }), { flag: 'wx', mode: 0o600 });
  renameSync(temporary, ${JSON.stringify(join(root, 'ready.json'))});
});
`, { mode: 0o700 });
  const program = `import { probe } from '@deepseek-ai/node-addon-system/landlock-run'; process.stdout.write(probe(process.argv[1], { timeoutMs: 5000 }));`;
  pending = promisify(execFile)(process.execPath, ['--input-type=module', '--eval', program, client],
    { timeout: 30_000, killSignal: 'SIGKILL', env: { ...process.env, NODE_OPTIONS: undefined, NODE_PATH: undefined } })
    .then(value => ({ value }), error => ({ error }));
  const readyDeadline = performance.now() + 20_000;
  while (marker === undefined) {
    try { marker = JSON.parse(await readFile(join(root, 'ready.json'), 'utf8')); }
    catch (error) { if (error.code !== 'ENOENT' || performance.now() >= readyDeadline) throw error; await delay(10); }
  }
  assert.equal(await endpoint(), marker.token);
  const result = await Promise.race([pending, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Landlock probe outlived its deadline')), 15_000); })]);
  assert.ok(result.value, result.error?.message);
  assert.equal(result.value.stdout, 'unusable');
  assert.equal(await endpoint(), undefined);
} catch (error) { primaryError = error; throw error; }
finally {
  clearTimeout(timer);
  const failures = [];
  if (marker !== undefined) { try { await endpoint(true); } catch (error) { failures.push(error); } }
  await pending;
  try { await rm(root, { recursive: true, force: true }); } catch (error) { failures.push(error); }
  if (failures.length > 0) throw new AggregateError(primaryError === undefined ? failures : [primaryError, ...failures], 'Native probe cleanup failed');
}
