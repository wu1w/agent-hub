import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';

const app = path.resolve(process.argv[2] || 'dist/macos-arm64/Agent Hub.app');
const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'hub-package-smoke-'));
const runtime = path.join(app, 'Contents/Resources/runtime');
const child = spawn(path.join(runtime, 'node'), [path.join(runtime, 'server.mjs')], {
  cwd: tmp, env: { HOME: tmp, PATH: '/usr/bin:/bin', TMPDIR: os.tmpdir(), HUB_LANG: 'en', AGENT_HUB_ROOT: path.join(tmp, '.agent-hub') },
  stdio: ['pipe', 'pipe', 'pipe'],
});
let buffer = '', errors = '';
child.stderr.on('data', chunk => { errors += chunk.toString(); });
const exited = new Promise(resolve => child.once('close', (code, signal) => resolve({ code, signal })));
try {
  const ready = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Packaged backend startup timed out')), 15000);
    child.once('error', reject);
    child.once('close', () => { clearTimeout(timer); reject(new Error(`Backend exited before ready: ${errors}`)); });
    child.stdout.on('data', chunk => {
      buffer += chunk.toString();
      let end;
      while ((end = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
        try { const value = JSON.parse(line); if (value.type === 'ready') { clearTimeout(timer); resolve(value); } } catch { /* discard ordinary startup output */ }
      }
    });
  });
  const origin = `http://127.0.0.1:${ready.port}`;
  assert.equal((await fetch(origin + '/api/snapshot')).status, 401);
  const headers = { 'x-hub-token': ready.token };
  const page = await fetch(origin + '/', { headers });
  assert.equal(page.status, 200); assert.match(await page.text(), /Agent Hub/);
  for (const asset of ['app.js', 'app.css', 'i18n.js', 'errors.js', 'vault-draft.js', 'quick-switcher.js']) {
    const response = await fetch(origin + '/' + asset, { headers });
    assert.equal(response.status, 200, `Packaged asset missing: ${asset}`);
    assert.ok((await response.text()).length > 0, `Packaged asset empty: ${asset}`);
  }
  const snapshotResponse = await fetch(origin + '/api/snapshot', { headers });
  assert.equal(snapshotResponse.status, 200);
  const snapshot = await snapshotResponse.json();
  assert.equal(snapshot.catalog.length, 24);
  assert.ok(snapshot.catalog.some(agent => agent.id === 'deepseek'));
  assert.equal(await fs.realpath(snapshot.hubRoot), await fs.realpath(path.join(tmp, '.agent-hub')));
  assert.ok(snapshot.sync.assets);
  // Closing the owning app's pipe must stop its backend without leaving an orphan.
  child.stdin.end();
  const stopped = await Promise.race([exited, new Promise((_, reject) => setTimeout(() => reject(new Error('Backend did not exit after parent pipe closed')), 10000).unref())]);
  assert.equal(stopped.code, 0);
  await assert.rejects(fs.stat(path.join(tmp, '.agent-hub/desktop-runtime.json')), { code: 'ENOENT' });
  console.log(JSON.stringify({ package: path.basename(app), version: ready.version, isolatedHome: true, systemPathOnly: true, authentication: true, staticAssets: true, catalog: snapshot.catalog.length, parentExitCleanup: true }));
} finally {
  if (child.exitCode === null) child.kill('SIGTERM');
  await exited;
  await fs.rm(tmp, { recursive: true, force: true });
}
