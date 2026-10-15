#!/usr/bin/env node
import fs from 'node:fs';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { loadSettings, saveSettings, ensureHome, PATHS, DEFAULT_SETTINGS } from '../src/store.js';

const HELP = `pprox: pool Puter accounts behind OpenAI/Anthropic-compatible endpoints

usage:
  pprox serve [--port 9032] [--host 127.0.0.1] [--bg]   start the server
  pprox stop                                            stop a background server
  pprox status                                          server and pool summary
  pprox open                                            open the web UI

  pprox accounts                                        list accounts
  pprox accounts add [--headless] [--token TOKEN]       link a Puter account
  pprox accounts rm <id|username>
  pprox accounts enable|disable <id|username>
  pprox accounts refresh                                re-fetch monthly usage

  pprox strategy [name]                                 show or set routing strategy
  pprox config [key] [value]                            show or set a setting
  pprox models [filter]                                 list Puter models
  pprox manage key [--rotate]                           create or show the management API master key
  pprox logs [-f]                                       print the background server log

env: PPROXY_HOME (default ~/.pproxy), PPROXY_URL (default from settings), PPROXY_MASTER_KEY`;

const { values: flags, positionals } = parseArgs({
    allowPositionals: true,
    strict: false,
    options: {
        port: { type: 'string', short: 'p' },
        host: { type: 'string' },
        bg: { type: 'boolean' },
        headless: { type: 'boolean' },
        token: { type: 'string' },
        follow: { type: 'boolean', short: 'f' },
        rotate: { type: 'boolean' },
        help: { type: 'boolean', short: 'h' },
    },
});

const [cmd, sub, ...rest] = positionals;

function die (msg) {
    console.error(`pprox: ${msg}`);
    process.exit(1);
}

function baseUrl () {
    if (process.env.PPROXY_URL) return process.env.PPROXY_URL.replace(/\/$/, '');
    const s = loadSettings();
    const host = ['0.0.0.0', '::', ''].includes(s.host) ? '127.0.0.1' : s.host;
    return `http://${host.includes(':') ? `[${host}]` : host}:${s.port}`;
}

async function api (method, path, body) {
    const s = loadSettings();
    const headers = { 'Content-Type': 'application/json' };
    if (s.apiKey) headers.Authorization = `Bearer ${s.apiKey}`;
    let res;
    try {
        res = await fetch(baseUrl() + path, { method, headers, body: body ? JSON.stringify(body) : undefined });
    } catch {
        die(`server not reachable at ${baseUrl()}. Start it with \`pprox serve --bg\`.`);
    }
    const data = await res.json().catch(() => ({}));
    if (!res.ok) die(data?.error?.message ?? data?.message ?? `HTTP ${res.status}`);
    return data;
}

const credit = (v, unit) => v == null ? '?' : unit === 'microcents' ? `$${(v / 1e8).toFixed(2)}` : `${v > 0 && v < 1 ? v.toPrecision(2) : Math.round(v * 10) / 10}`;

function readPid () {
    try {
        const pid = Number(fs.readFileSync(PATHS.pid, 'utf8'));
        process.kill(pid, 0);
        return pid;
    } catch {
        return null;
    }
}

async function waitForHealth (ms) {
    const end = Date.now() + ms;
    while (Date.now() < end) {
        try {
            const r = await fetch(`${baseUrl()}/health`);
            if (r.ok) return true;
        } catch { /* not up yet */ }
        await new Promise(r => setTimeout(r, 200));
    }
    return false;
}

async function serve () {
    const overrides = {};
    if (flags.port) overrides.port = Number(flags.port);
    if (flags.host) overrides.host = flags.host;
    if (overrides.port || overrides.host) {
        // Remember them so the CLI knows where to find the server later.
        saveSettings({ ...loadSettings(), ...overrides });
    }

    if (flags.bg) {
        const running = readPid();
        if (running) die(`already running (pid ${running})`);
        ensureHome();
        const out = fs.openSync(PATHS.log, 'a');
        const child = spawn(process.execPath, [fileURLToPath(import.meta.url), 'serve'], {
            detached: true,
            stdio: ['ignore', out, out],
            env: process.env,
        });
        child.unref();
        if (await waitForHealth(10000)) {
            console.log(`pproxy running in the background (pid ${child.pid}) at ${baseUrl()}`);
            console.log(`log: ${PATHS.log}`);
        } else {
            die(`server did not come up; check ${PATHS.log}`);
        }
        return;
    }

    const { createServer } = await import('../src/server.js');
    const app = createServer(overrides);
    let addr;
    try {
        addr = await app.listen();
    } catch (e) {
        die(e.code === 'EADDRINUSE' ? `port ${app.settings.port} is already in use` : e.message);
    }
    fs.writeFileSync(PATHS.pid, String(process.pid));
    const shown = baseUrl();
    console.log(`pproxy ${shown}  (${app.pool.accounts.length} account${app.pool.accounts.length === 1 ? '' : 's'}, ${app.settings.strategy})`);
    console.log(`  OpenAI:    ${shown}/v1/chat/completions, ${shown}/v1/responses`);
    console.log(`  Anthropic: ${shown}/v1/messages`);
    if (!['127.0.0.1', 'localhost', '::1'].includes(addr.address) && !app.settings.apiKey) {
        console.log('  warning: listening beyond loopback with no API key. Set one with `pprox config apiKey <key>`.');
    }
    const shutdown = async () => {
        await app.close();
        try { if (Number(fs.readFileSync(PATHS.pid, 'utf8')) === process.pid) fs.unlinkSync(PATHS.pid); } catch { /* gone */ }
        process.exit(0);
    };
    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);
}

async function listAccounts () {
    const list = await api('GET', '/api/accounts');
    if (!list.length) return console.log('no accounts yet. Add one with `pprox accounts add`.');
    for (const a of list) {
        const u = a.usage;
        const remaining = u ? `${credit(u.remaining, u.unit)} of ${credit(u.allowance, u.unit)}${u.unit && u.unit !== 'microcents' ? ` ${u.unit}` : ''} left` : 'usage unknown';
        const flagsTxt = [!a.enabled && 'disabled', a.status !== 'ok' && a.status].filter(Boolean).join(', ');
        console.log(`${a.username.padEnd(20)} ${a.id}  ${remaining}  ${a.stats.requests} req${flagsTxt ? `  [${flagsTxt}]` : ''}`);
    }
}

async function accounts () {
    if (!sub || sub === 'list' || sub === 'ls') return listAccounts();
    if (sub === 'add') {
        if (flags.token) {
            const a = await api('POST', '/api/accounts', { token: flags.token });
            return console.log(`added ${a.username} (${a.id})`);
        }
        const { state, url } = await api('POST', '/api/link', { base: baseUrl() });
        if (flags.headless) {
            console.log(`Open this link and sign in to Puter:\n\n  ${url}\n`);
            console.log('If the browser cannot reach this server afterwards, copy the token= value from the URL it lands on and run `pprox accounts add --token <token>`.');
        } else {
            console.log(`Opening Puter sign-in in your browser. If nothing opens, visit:\n  ${url}`);
            const { default: open } = await import('open');
            open(url).catch(() => {});
        }
        process.stdout.write('waiting for sign-in');
        const end = Date.now() + 15 * 60 * 1000;
        while (Date.now() < end) {
            await new Promise(r => setTimeout(r, 1500));
            const l = await api('GET', `/api/link/${state}`);
            if (l.status === 'done') return console.log(`\nadded ${l.account.username} (${l.account.id})`);
            if (l.status === 'error') die(`\n${l.error}`);
            process.stdout.write('.');
        }
        die('\ntimed out waiting for sign-in');
    }
    if (sub === 'rm' || sub === 'remove') {
        if (!rest[0]) die('usage: pprox accounts rm <id|username>');
        await api('DELETE', `/api/accounts/${encodeURIComponent(rest[0])}`);
        return console.log(`removed ${rest[0]}`);
    }
    if (sub === 'enable' || sub === 'disable') {
        if (!rest[0]) die(`usage: pprox accounts ${sub} <id|username>`);
        const a = await api('PATCH', `/api/accounts/${encodeURIComponent(rest[0])}`, { enabled: sub === 'enable' });
        return console.log(`${a.username} ${sub}d`);
    }
    if (sub === 'refresh') {
        await api('POST', '/api/accounts/refresh');
        return listAccounts();
    }
    die(`unknown accounts command "${sub}"`);
}

async function main () {
    if (flags.help || !cmd || cmd === 'help') return console.log(HELP);
    switch (cmd) {
    case 'serve':
    case 'start':
        return serve();
    case 'stop': {
        const pid = readPid();
        if (!pid) return console.log('not running');
        process.kill(pid, 'SIGTERM');
        return console.log(`stopped (pid ${pid})`);
    }
    case 'status': {
        const s = await api('GET', '/api/status');
        return console.log(`pproxy ${s.version} at ${baseUrl()} (pid ${s.pid}), up ${Math.round(s.uptime / 1000)}s\n${s.usable}/${s.accounts} accounts usable, strategy ${s.strategy}`);
    }
    case 'open': {
        const { default: open } = await import('open');
        console.log(baseUrl());
        return open(baseUrl());
    }
    case 'accounts':
    case 'account':
        return accounts();
    case 'strategy': {
        if (!sub) {
            const s = await api('GET', '/api/settings');
            for (const [k, v] of Object.entries(s.strategies)) console.log(`${k === s.strategy ? '*' : ' '} ${k.padEnd(15)} ${v}`);
            return;
        }
        const s = await api('PATCH', '/api/settings', { strategy: sub });
        return console.log(`strategy: ${s.strategy}`);
    }
    case 'config': {
        const local = loadSettings();
        if (!sub) {
            const shown = { ...local, apiKey: local.apiKey ? '(set)' : null, masterKey: local.masterKey ? '(set)' : null };
            return console.log(JSON.stringify(shown, null, 2));
        }
        if (!(sub in DEFAULT_SETTINGS)) die(`unknown setting "${sub}"`);
        if (rest[0] === undefined) return console.log(JSON.stringify(['apiKey', 'masterKey'].includes(sub) && local[sub] ? '(set)' : local[sub]));
        let value = rest.join(' ');
        try { value = JSON.parse(value); } catch { /* plain string */ }
        if (value === 'null' || value === '') value = null;
        if (['host', 'port'].includes(sub)) {
            saveSettings({ ...local, [sub]: value });
            return console.log(`${sub} saved; restart the server to apply`);
        }
        if (readPid()) {
            await api('PATCH', '/api/settings', { [sub]: value });
        } else {
            saveSettings({ ...local, [sub]: value });
        }
        return console.log(`${sub} updated`);
    }
    case 'models': {
        const list = await api('GET', '/api/models');
        const f = sub?.toLowerCase();
        for (const m of list) {
            if (f && !`${m.id} ${m.provider} ${m.name ?? ''}`.toLowerCase().includes(f)) continue;
            console.log(`${m.id.padEnd(48)} ${m.provider ?? ''}`);
        }
        return;
    }
    case 'manage': {
        if (sub !== 'key') die('usage: pprox manage key [--rotate]');
        const local = loadSettings();
        if (local.masterKey && !flags.rotate) return console.log(local.masterKey);
        const key = `pmk_${crypto.randomBytes(24).toString('base64url')}`;
        saveSettings({ ...local, masterKey: key });
        if (readPid()) await api('PATCH', '/api/settings', { masterKey: key });
        console.log(key);
        return console.error('send it as `Authorization: Bearer <key>` or `x-master-key` to /manage/v1/*');
    }
    case 'logs': {
        if (!fs.existsSync(PATHS.log)) return console.log('no log yet');
        if (flags.follow) {
            spawn('tail', ['-n', '50', '-f', PATHS.log], { stdio: 'inherit' });
            return;
        }
        return process.stdout.write(fs.readFileSync(PATHS.log, 'utf8').split('\n').slice(-100).join('\n'));
    }
    default:
        die(`unknown command "${cmd}". Try \`pprox help\`.`);
    }
}

main().catch(e => die(e.message));
