import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export function verify(config, base = root) {
  assert.equal(config.main, 'cloudflare/src/worker.mjs', 'Deploy the D1 Worker, not an HTML preview');
  assert.equal(config.assets?.directory, './cloudflare/public', 'Never deploy preview/ or the repository as static assets');
  assert.equal(config.assets?.binding, 'ASSETS');
  assert.ok(config.assets.run_worker_first?.includes('/api/*'), 'API requests must reach the Worker');
  assert.ok(config.d1_databases?.some(x => x.binding === 'DB' && x.database_name === 'gugu-ordering-db'), 'The production API needs its own D1 binding');
  const publicDir = resolve(base, config.assets.directory);
  const visit = (dir) => {
    for (const name of readdirSync(dir)) {
      const path = resolve(dir, name);
      if (statSync(path).isDirectory()) visit(path);
      else if (/\.(html|m?js)$/.test(name)) {
        assert.doesNotMatch(readFileSync(path, 'utf8'), /GUGU_PREVIEW|window\.DemoAPI|互動體驗版/, `Offline demo found in production assets: ${path}`);
      }
    }
  };
  visit(publicDir);
  const html = readFileSync(resolve(publicDir, 'index.html'), 'utf8');
  assert.ok(html.includes('/static/app.js'), 'The production frontend must load its real API client');
  const js = readFileSync(resolve(publicDir, 'static/app.js'), 'utf8');
  assert.match(js, /fetch\(path/);
  return true;
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const config = JSON.parse(readFileSync(resolve(root, 'wrangler.jsonc'), 'utf8'));
  verify(config);
  console.log('PASS: root entry deploys the real Cloudflare API and only production assets.');
}
