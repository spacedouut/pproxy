import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.PPROXY_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'pproxy-discord-'));
process.env.PPROXY_MASTER_KEY = 'mk';
const { createServer } = await import('../src/server.js');
const { createCommands, DEFINITIONS } = await import('../discord/commands.js');

let app;
let base;

before(async () => {
    app = createServer({ port: 0, host: '127.0.0.1' });
    app.pool.addToken = async (token) => {
        if (token === 'bad') throw Object.assign(new Error('token_auth_failed'), { status: 401 });
        const a = { id: 'u-' + token, username: 'bob', enabled: true, weight: 1, status: 'ok', usage: { remaining: 900, allowance: 1000, unit: 'credits' }, stats: { requests: 0 } };
        app.pool.accounts.push(a);
        return app.pool.view(a);
    };
    const addr = await app.listen();
    base = `http://127.0.0.1:${addr.port}`;
});

after(async () => {
    clearInterval(app.pool.refreshTimer);
    await app.close();
});

function fake (commandName, opts = {}, userId = 'u1') {
    const it = {
        commandName,
        user: { id: userId },
        options: { getString: (k) => opts[k] ?? null },
        replies: [],
        deferred: null,
        async deferReply (o) { it.deferred = o; },
        async reply (o) { it.replies.push(o); },
        async editReply (o) { it.replies.push(typeof o === 'string' ? { content: o } : o); },
    };
    return it;
}

test('definitions are /add and /accounts', () => {
    assert.deepEqual(DEFINITIONS.map(d => d.name), ['add', 'accounts']);
});

test('/add with a token adds the account', async () => {
    const c = createCommands({ pproxyUrl: base, masterKey: 'mk' });
    const it = fake('add', { token: 'abc' });
    await c.handle(it);
    assert.equal(it.deferred.flags, 64);
    assert.match(it.replies.at(-1).content, /^Added \*\*bob\*\* `u-abc` 900 of 1000 credits left/);
});

test('/add with a bad token reports the error', async () => {
    const c = createCommands({ pproxyUrl: base, masterKey: 'mk' });
    const it = fake('add', { token: 'bad' });
    await c.handle(it);
    assert.match(it.replies.at(-1).content, /Could not add account: token_auth_failed/);
});

test('/add without a token sends a sign-in link and updates when the callback lands', async () => {
    const c = createCommands({ pproxyUrl: base, masterKey: 'mk', publicUrl: 'https://pp.example', pollMs: 20, timeoutMs: 5000 });
    const it = fake('add');
    const done = c.handle(it);
    while (!it.replies.length) await new Promise(r => setTimeout(r, 10));
    const url = new URL(it.replies[0].components[0].components[0].url);
    const redirect = new URL(url.searchParams.get('redirectURL'));
    assert.equal(redirect.origin, 'https://pp.example');
    const cb = await fetch(`${base}${redirect.pathname}?token=xyz`);
    assert.equal(cb.status, 200);
    await done;
    assert.match(it.replies.at(-1).content, /^Added \*\*bob\*\* `u-xyz`/);
    assert.deepEqual(it.replies.at(-1).components, []);
});

test('/accounts lists accounts', async () => {
    const c = createCommands({ pproxyUrl: base, masterKey: 'mk' });
    const it = fake('accounts');
    await c.handle(it);
    assert.match(it.replies.at(-1).content, /\*\*bob\*\* `u-abc`/);
});

test('allowed users and a wrong master key', async () => {
    let it = fake('accounts', {}, 'stranger');
    await createCommands({ pproxyUrl: base, masterKey: 'mk', allowedUsers: ['u1'] }).handle(it);
    assert.equal(it.deferred, null);
    assert.match(it.replies[0].content, /not allowed/);

    it = fake('accounts');
    await createCommands({ pproxyUrl: base, masterKey: 'nope' }).handle(it);
    assert.match(it.replies.at(-1).content, /pproxy error: invalid or missing master key/);
});
