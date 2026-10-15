import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';

process.env.PPROXY_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'pproxy-test-'));
const { createServer, resolveModel } = await import('../src/server.js');

let app;
let base;
const calls = [];

before(async () => {
    app = createServer({ port: 0, host: '127.0.0.1' });
    app.pool.open = async (args) => {
        calls.push(args);
        async function * chunks () {
            yield { type: 'text', text: 'pong' };
            yield { type: 'usage', usage: { input_tokens: 3, output_tokens: 1 }, finish_reason: 'stop' };
        }
        return { account: { id: 'u1', username: 'alice' }, chunks: chunks() };
    };
    const addr = await app.listen();
    base = `http://127.0.0.1:${addr.port}`;
});

after(async () => {
    clearInterval(app.pool.refreshTimer);
    await app.close();
});

const post = (p, body, headers = {}) => fetch(base + p, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) });

test('resolveModel applies exact and glob aliases', () => {
    const s = { defaultModel: 'd', modelMap: { fast: 'gpt-5-nano', 'claude-*': 'claude-sonnet-4-5' } };
    assert.equal(resolveModel(undefined, s), 'd');
    assert.equal(resolveModel('fast', s), 'gpt-5-nano');
    assert.equal(resolveModel('claude-3-opus', s), 'claude-sonnet-4-5');
    assert.equal(resolveModel('other', s), 'other');
});

test('chat completions round trip', async () => {
    const r = await post('/v1/chat/completions', { model: 'm', messages: [{ role: 'user', content: 'ping' }] });
    assert.equal(r.status, 200);
    assert.equal(r.headers.get('x-pproxy-account'), 'alice');
    const j = await r.json();
    assert.equal(j.choices[0].message.content, 'pong');
    assert.equal(calls.at(-1).normalize, true);
});

test('anthropic messages at /messages and /v1/messages', async () => {
    for (const p of ['/messages', '/v1/messages']) {
        const r = await post(p, { model: 'm', max_tokens: 5, messages: [{ role: 'user', content: 'ping' }] });
        const j = await r.json();
        assert.equal(j.content[0].text, 'pong');
    }
});

test('responses streaming', async () => {
    const r = await post('/v1/responses', { model: 'm', input: 'ping', stream: true });
    assert.match(r.headers.get('content-type'), /event-stream/);
    const text = await r.text();
    assert.match(text, /response\.completed/);
    assert.equal(calls.at(-1).streamToolInput, true);
});

test('rejects foreign Host and cross-origin requests', async () => {
    // fetch() drops a custom Host header, so use http.request.
    const status = await new Promise((resolve, reject) => {
        http.get(base + '/api/status', { headers: { Host: 'evil.example' } }, (res) => { res.resume(); resolve(res.statusCode); }).on('error', reject);
    });
    assert.equal(status, 403);
    const r2 = await post('/api/settings', {}, { Origin: 'https://evil.example' });
    assert.equal(r2.status, 403);
});

test('settings: strategy validation and API key enforcement', async () => {
    const bad = await fetch(base + '/api/settings', { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ strategy: 'nope' }) });
    assert.equal(bad.status, 400);
    const ok = await fetch(base + '/api/settings', { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ strategy: 'least-busy', apiKey: 'k' }) });
    const s = await ok.json();
    assert.equal(s.strategy, 'least-busy');
    assert.equal(s.apiKeySet, true);
    assert.equal(s.apiKey, undefined);

    const denied = await post('/v1/messages', { messages: [] }, { 'anthropic-version': '2023-06-01' });
    assert.equal(denied.status, 401);
    assert.equal((await denied.json()).type, 'error');
    const allowed = await post('/v1/chat/completions', { messages: [{ role: 'user', content: 'x' }] }, { Authorization: 'Bearer k' });
    assert.equal(allowed.status, 200);
    const viaHeader = await post('/v1/messages', { max_tokens: 5, messages: [{ role: 'user', content: 'x' }] }, { 'x-api-key': 'k' });
    assert.equal(viaHeader.status, 200);
});

test('management API: off without a key, then master key auth and request ids', async () => {
    const mpost = (p, body, key) => post(p, body, key ? { Authorization: `Bearer ${key}` } : {});
    let r = await mpost('/manage/v1/set-strategy', { strategy: 'priority' }, 'x');
    assert.equal(r.status, 503);

    app.settings.masterKey = 'mk';
    r = await mpost('/manage/v1/set-strategy', { strategy: 'priority' }, 'wrong');
    assert.equal(r.status, 401);

    r = await mpost('/manage/v1/set-strategy', { strategy: 'priority' }, 'mk');
    let j = await r.json();
    assert.equal(r.status, 200);
    assert.equal(j.status, 'succeeded');
    assert.equal(r.headers.get('x-request-id'), j.request_id);
    assert.equal(app.settings.strategy, 'priority');

    r = await mpost('/manage/v1/change-weight', { account: 'nobody', weight: 2 }, 'mk');
    j = await r.json();
    assert.equal(r.status, 404);
    assert.equal(j.status, 'failed');
    const g = await fetch(`${base}/manage/v1/request?id=${j.request_id}`, { headers: { 'x-master-key': 'mk' } });
    const rec = await g.json();
    assert.equal(rec.status, 'failed');
    assert.match(rec.error.message, /no such account/);

    app.pool.addToken = async (token) => {
        app.pool.accounts.push({ id: 'u9', username: 'bob', token, enabled: true, weight: 1, status: 'ok', usage: null, stats: { requests: 0, errors: 0, inputTokens: 0, outputTokens: 0, cost: 0 } });
        return app.pool.view(app.pool.accounts.at(-1));
    };
    r = await mpost('/manage/v1/add-account', { token: 'secret-token' }, 'mk');
    j = await r.json();
    assert.equal(j.status, 'succeeded');
    assert.equal(j.result.username, 'bob');
    assert.equal(j.params.token, '(redacted)');

    r = await mpost('/manage/v1/change-weight', { account: 'bob', weight: 3 }, 'mk');
    j = await r.json();
    assert.equal(j.result.weight, 3);

    r = await mpost('/manage/v1/add-account', {}, 'mk');
    j = await r.json();
    assert.equal(r.status, 202);
    assert.equal(j.status, 'pending');
    assert.match(j.result.url, /action=authme/);

    r = await mpost('/manage/v1/remove-account?async=1', { account: 'bob' }, 'mk');
    assert.equal(r.status, 202);
    app.settings.masterKey = null;
    app.settings.strategy = 'round-robin';
});
