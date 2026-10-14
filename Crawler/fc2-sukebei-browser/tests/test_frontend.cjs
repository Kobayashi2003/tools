const { readFileSync } = require('node:fs');
const { resolve } = require('node:path');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const { test } = require('node:test');

const source = readFileSync(resolve(__dirname, '../app/static/app.js'), 'utf8');
const apiCode = source.slice(source.indexOf('async function api('), source.indexOf('let toastTimer'));

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
