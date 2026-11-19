const { readFileSync } = require('node:fs');
const { resolve } = require('node:path');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const { test } = require('node:test');

const source = readFileSync(resolve(__dirname, '../app/static/app.js'), 'utf8');
const apiCode = source.slice(source.indexOf('async function api('), source.indexOf('let toastTimer'));
const presentation = import(`data:text/javascript;base64,${Buffer.from(readFileSync(resolve(__dirname, '../app/static/presentation.js'), 'utf8')).toString('base64')}`);

test('recommendations exclude executable bundles, break ties by size and preserve input order', async () => {
  const { sortedTorrents, bestTorrent } = await presentation;
  const torrents = [
    { view_id: 1, seeders: 2, size_bytes: 200, risky: false },
    { view_id: 2, seeders: 30, size_bytes: 1000, risky: true },
    { view_id: 3, seeders: 2, size_bytes: 800, risky: false },
    { view_id: 4, seeders: 2, size_bytes: 900, risky: true },
  ];
  assert.deepEqual(sortedTorrents(torrents).map(t => t.view_id), [2, 3, 1, 4]);
  assert.equal(bestTorrent(torrents).view_id, 3);
  assert.deepEqual(torrents.map(t => t.view_id), [1, 2, 3, 4]);
  assert.equal(bestTorrent([{ seeders: 0, size_bytes: 500, risky: false }]), null);
  assert.equal(bestTorrent([{ seeders: 10, size_bytes: 500, risky: true }]), null);
  assert.equal(bestTorrent([]), null);
});

test('source switch sends a JSON PUT body', async () => {
  const context = vm.createContext({
    fetch: async (path, init) => {
      assert.equal(path, 'api/source');
      assert.equal(init.method, 'PUT');
      assert.equal(init.headers['Content-Type'], 'application/json');
      assert.deepEqual(JSON.parse(init.body), { source: 'nyaa_cn' });
      return { ok: true, json: async () => ({ source: 'nyaa_cn' }) };
    },
  });
  vm.runInContext(apiCode, context);
  await vm.runInContext("api('api/source', { method: 'PUT', body: { source: 'nyaa_cn' } })", context);
});

test('validation errors show their message instead of object Object', async () => {
  const context = vm.createContext({
    fetch: async () => ({
      ok: false,
      status: 422,
      json: async () => ({ detail: [{ loc: ['body', 'source'], msg: 'Invalid source' }] }),
    }),
  });
  vm.runInContext(apiCode, context);
  await assert.rejects(vm.runInContext("api('api/source')", context), (err) => {
    assert.equal(err.status, 422);
    assert.match(err.message, /Invalid source/);
    assert.doesNotMatch(err.message, /\[object Object\]/);
    return true;
  });
});
