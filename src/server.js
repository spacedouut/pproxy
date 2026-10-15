import http from 'node:http';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Pool, STRATEGIES } from './pool.js';
import { createPuter, PUTER_GUI } from './puter.js';
import { toBlockEvents, collect } from './blocks.js';
import { loadSettings, saveSettings, ensureHome } from './store.js';
import { HttpError } from './formats/common.js';
import * as chat from './formats/chat.js';
import * as anthropic from './formats/anthropic.js';
import * as responses from './formats/responses.js';

const UI_FILE = fileURLToPath(new URL('../public/index.html', import.meta.url));
const VERSION = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url))).version;
const MAX_BODY = 64 * 1024 * 1024;
const LINK_TTL_MS = 15 * 60 * 1000;
const LOOPBACK = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);

const FORMATS = {
    chat: { mod: chat, errorBody: chat.errorBody },
    anthropic: { mod: anthropic, errorBody: anthropic.errorBody },
    responses: { mod: responses, errorBody: chat.errorBody },
};

function globToRegex (glob) {
    return new RegExp(`^${glob.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*')}$`, 'i');
}

export function resolveModel (requested, settings) {
    const map = settings.modelMap ?? {};
    if (!requested) return settings.defaultModel;
    if (map[requested]) return map[requested];
    for (const [from, to] of Object.entries(map)) {
        if (from.includes('*') && globToRegex(from).test(requested)) return to;
    }
    return requested;
}

function readBody (req) {
    return new Promise((resolve, reject) => {
        const chunks = [];
        let size = 0;
        req.on('data', (c) => {
            size += c.length;
            if (size > MAX_BODY) {
                reject(new HttpError(413, 'request body too large'));
                req.destroy();
                return;
            }
            chunks.push(c);
        });
        req.on('end', () => {
            const raw = Buffer.concat(chunks).toString('utf8');
            if (!raw) return resolve({});
            try {
                resolve(JSON.parse(raw));
            } catch {
                reject(new HttpError(400, 'request body is not valid JSON'));
            }
        });
        req.on('error', reject);
    });
}

function escapeHtml (s) {
    return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

function json (res, status, body) {
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(body));
}

function hostnameOf (hostHeader) {
    if (!hostHeader) return '';
    if (hostHeader.startsWith('[')) return hostHeader.slice(0, hostHeader.indexOf(']') + 1);
    return hostHeader.split(':')[0];
}

export function createServer (overrides = {}) {
    ensureHome();
    const settings = { ...loadSettings(), ...overrides };
    const pool = new Pool(settings);
    const links = new Map();
    const log = [];
    const startedAt = Date.now();
    let modelCache = null;

    const persist = () => {
        const { host, port, ...rest } = settings;
        const saved = loadSettings();
        saveSettings({ ...saved, ...rest, host: saved.host, port: saved.port });
    };

    const publicSettings = () => ({
        host: settings.host,
        port: settings.port,
        strategy: settings.strategy,
        strategies: STRATEGIES,
        failover: settings.failover,
        defaultModel: settings.defaultModel,
        modelMap: settings.modelMap,
        usageRefreshSec: settings.usageRefreshSec,
        apiKeySet: !!settings.apiKey,
    });

    async function models () {
        if (modelCache && Date.now() - modelCache.at < 10 * 60 * 1000) return modelCache.list;
        const puter = pool.accounts[0] ? pool.rt(pool.accounts[0]).puter : createPuter();
        const raw = await puter.ai.listModels();
        const seen = new Map();
        for (const m of raw ?? []) if (m?.id && !seen.has(m.id)) seen.set(m.id, m);
        modelCache = { at: Date.now(), list: [...seen.values()] };
        return modelCache.list;
    }

    function record (entry) {
        log.unshift(entry);
        if (log.length > 200) log.length = 200;
    }

    // ---- completion endpoints -------------------------------------------

    async function complete (kind, req, res, body) {
        const { mod, errorBody } = FORMATS[kind];
        const t0 = Date.now();
        const entry = { time: t0, format: kind, model: body.model ?? null, puterModel: null, account: null, status: 0, ms: 0, stream: !!body.stream };
        let headersSent = false;
        try {
            const parsed = mod.parse(body);
            const requested = parsed.args.model;
            parsed.args.model = resolveModel(requested, settings);
            parsed.args.normalize = true;
            if (parsed.stream) parsed.args.streamToolInput = true;
            entry.puterModel = parsed.args.model;

            const ctx = { model: requested || parsed.args.model, includeUsage: parsed.includeUsage, body, parsed };
            const pin = req.headers['x-pproxy-account'];
            const { account, chunks } = await pool.open(parsed.args, { pin });
            entry.account = account.username;
            res.setHeader('x-pproxy-account', account.username ?? account.id);

            const events = (async function * () {
                for await (const ev of toBlockEvents(chunks)) {
                    if (ev.t === 'done') Object.assign(entry, { input: ev.usage.input + ev.usage.cacheRead + ev.usage.cacheWrite, output: ev.usage.output, cost: ev.usage.cost });
                    if (ev.t === 'error') entry.error = ev.error.message;
                    yield ev;
                }
            })();

            if (parsed.stream) {
                res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
                headersSent = true;
                await mod.stream(events, (s) => {
                    if (res.destroyed) throw new HttpError(499, 'client disconnected');
                    res.write(s);
                }, ctx);
                res.end();
            } else {
                const result = await collect(events);
                json(res, 200, mod.respond(result, ctx));
            }
            entry.status = entry.error ? 502 : 200;
        } catch (e) {
            let status = e.status && e.status >= 400 && e.status < 600 ? e.status : (e instanceof SyntaxError ? 400 : 502);
            if (status === 502 && /model not found/i.test(e.message)) status = 404;
            entry.status = e.status === 499 ? 499 : status;
            entry.error = e.message;
            if (!headersSent) json(res, status, errorBody(status, e.message, e.code));
            else if (!res.destroyed) res.end();
        } finally {
            entry.ms = Date.now() - t0;
            record(entry);
        }
    }

    // ---- account linking -------------------------------------------------

    function startLink (base) {
        for (const [k, v] of links) if (Date.now() - v.created > LINK_TTL_MS) links.delete(k);
        const state = crypto.randomUUID();
        const redirect = `${base.replace(/\/$/, '')}/auth/callback/${state}`;
        const url = new URL(PUTER_GUI);
        url.searchParams.set('action', 'authme');
        url.searchParams.set('redirectURL', redirect);
        links.set(state, { created: Date.now(), status: 'pending' });
        return { state, url: url.toString() };
    }

    async function finishLink (state, token, res) {
        const link = links.get(state);
        const page = (rawTitle, rawMsg) => {
            const title = escapeHtml(rawTitle);
            const msg = escapeHtml(rawMsg);
            res.writeHead(link ? 200 : 400, { 'Content-Type': 'text/html; charset=utf-8' });
            res.end(`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>${title}</title>
<style>body{background:#000;color:#eee;font:16px/1.5 system-ui,sans-serif;display:grid;place-items:center;min-height:100vh;margin:0}main{max-width:28rem;padding:2rem}h1{font-size:1.25rem;margin:0 0 .5rem}p{color:#aaa;margin:0}</style>
<main><h1>${title}</h1><p>${msg}</p></main><script>history.replaceState(null, '', location.pathname)</script>`);
        };
        if (!link || link.status !== 'pending') return page('Link expired', 'Start again from pproxy.');
        if (!token) {
            link.status = 'error';
            link.error = 'Puter did not return a token';
            return page('Sign-in failed', 'Puter did not return a token. Start again from pproxy.');
        }
        try {
            const account = await pool.addToken(token);
            Object.assign(link, { status: 'done', account });
            page(`Added ${account.username}`, 'You can close this tab.');
        } catch (e) {
            Object.assign(link, { status: 'error', error: e.message });
            page('Could not add account', e.message);
        }
    }

    // ---- routing ---------------------------------------------------------

    function authorized (req) {
        if (!settings.apiKey) return true;
        const bearer = req.headers.authorization?.replace(/^Bearer\s+/i, '');
        return bearer === settings.apiKey || req.headers['x-api-key'] === settings.apiKey;
    }

    async function handle (req, res) {
        const url = new URL(req.url, 'http://localhost');
        const p = url.pathname.replace(/\/+$/, '') || '/';
        const method = req.method;

        // Guard against DNS rebinding and cross-site requests to a local server.
        const host = hostnameOf(req.headers.host);
        if (LOOPBACK.has(settings.host) && host && !LOOPBACK.has(host)) {
            return json(res, 403, { error: { message: 'host not allowed' } });
        }
        const origin = req.headers.origin;
        if (origin && origin !== 'null') {
            let same = false;
            try { same = new URL(origin).host === req.headers.host; } catch { same = false; }
            if (!same) return json(res, 403, { error: { message: 'cross-origin requests are not allowed' } });
        }

        if (method === 'GET' && (p === '/' || p === '/index.html')) {
            res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
            return res.end(fs.readFileSync(UI_FILE));
        }
        if (method === 'GET' && p.startsWith('/auth/callback/')) {
            return finishLink(p.slice('/auth/callback/'.length), url.searchParams.get('token'), res);
        }
        if (p === '/health') return json(res, 200, { ok: true });

        const fmtFor = (req.headers['anthropic-version'] || req.headers['x-api-key'] && !req.headers.authorization) ? 'anthropic' : 'chat';
        if (!authorized(req)) {
            return json(res, 401, FORMATS[fmtFor].errorBody(401, 'invalid or missing API key'));
        }

        let body = {};
        if (method === 'POST' || method === 'PATCH') {
            const ct = req.headers['content-type'] ?? '';
            if (!ct.includes('application/json')) {
                return json(res, 415, FORMATS[fmtFor].errorBody(400, 'Content-Type must be application/json'));
            }
            body = await readBody(req);
        }

        const v1 = p.replace(/^\/v1(?=\/)/, '');
        if (method === 'POST') {
            if (v1 === '/chat/completions') return complete('chat', req, res, body);
            if (v1 === '/messages') return complete('anthropic', req, res, body);
            if (v1 === '/responses') return complete('responses', req, res, body);
            if (v1 === '/messages/count_tokens') return json(res, 200, anthropic.countTokens(body));
        }
        if (method === 'GET' && v1 === '/models') {
            const list = await models();
            const aliases = Object.keys(settings.modelMap ?? {}).filter(k => !k.includes('*'));
            if (fmtFor === 'anthropic') {
                const data = [...aliases.map(id => ({ id, provider: 'alias' })), ...list].map(m => ({
                    type: 'model', id: m.id, display_name: m.name ?? m.id, created_at: m.release_date ? new Date(m.release_date).toISOString() : '1970-01-01T00:00:00Z',
                }));
                return json(res, 200, { data, has_more: false, first_id: data[0]?.id ?? null, last_id: data.at(-1)?.id ?? null });
            }
            const data = [...aliases.map(id => ({ id, provider: 'alias' })), ...list].map(m => ({
                id: m.id, object: 'model', created: m.release_date ? Math.floor(Date.parse(m.release_date) / 1000) || 0 : 0, owned_by: m.provider ?? 'puter',
            }));
            return json(res, 200, { object: 'list', data });
        }
        if (method === 'GET' && v1.startsWith('/responses/')) {
            return json(res, 404, chat.errorBody(404, 'pproxy does not keep retrievable response objects'));
        }

        // ---- admin API ----
        if (p === '/api/status' && method === 'GET') {
            return json(res, 200, {
                version: VERSION, pid: process.pid, uptime: Date.now() - startedAt,
                accounts: pool.accounts.length, usable: pool.usable().length, strategy: settings.strategy,
            });
        }
        if (p === '/api/accounts') {
            if (method === 'GET') return json(res, 200, pool.list());
            if (method === 'POST') return json(res, 200, await pool.addToken(body.token));
        }
        if (p === '/api/accounts/refresh' && method === 'POST') {
            await pool.refreshAll();
            return json(res, 200, pool.list());
        }
        const acct = p.match(/^\/api\/accounts\/([^/]+)$/);
        if (acct) {
            const key = decodeURIComponent(acct[1]);
            if (method === 'PATCH') {
                const v = pool.update(key, body);
                return v ? json(res, 200, v) : json(res, 404, { error: { message: 'no such account' } });
            }
            if (method === 'DELETE') {
                return pool.remove(key) ? json(res, 200, { ok: true }) : json(res, 404, { error: { message: 'no such account' } });
            }
        }
        if (p === '/api/link' && method === 'POST') {
            const base = body.base || `http://${req.headers.host}`;
            return json(res, 200, startLink(base));
        }
        const link = p.match(/^\/api\/link\/([^/]+)$/);
        if (link && method === 'GET') {
            const l = links.get(link[1]);
            return l ? json(res, 200, l) : json(res, 404, { error: { message: 'no such link' } });
        }
        if (p === '/api/settings') {
            if (method === 'GET') return json(res, 200, publicSettings());
            if (method === 'PATCH') {
                if (body.strategy !== undefined) {
                    if (!STRATEGIES[body.strategy]) return json(res, 400, { error: { message: `unknown strategy; pick one of ${Object.keys(STRATEGIES).join(', ')}` } });
                    settings.strategy = body.strategy;
                }
                if (typeof body.failover === 'boolean') settings.failover = body.failover;
                if (typeof body.defaultModel === 'string' && body.defaultModel) settings.defaultModel = body.defaultModel;
                if (body.modelMap && typeof body.modelMap === 'object') settings.modelMap = body.modelMap;
                if (body.apiKey !== undefined) settings.apiKey = body.apiKey || null;
                if (Number.isFinite(body.usageRefreshSec)) settings.usageRefreshSec = body.usageRefreshSec;
                persist();
                return json(res, 200, publicSettings());
            }
        }
        if (p === '/api/log' && method === 'GET') return json(res, 200, log);
        if (p === '/api/models' && method === 'GET') return json(res, 200, await models());

        return json(res, 404, FORMATS[fmtFor].errorBody(404, `no route for ${method} ${p}`));
    }

    const server = http.createServer((req, res) => {
        handle(req, res).catch((e) => {
            const status = e.status && e.status >= 400 && e.status < 600 ? e.status : 500;
            if (!res.headersSent) json(res, status, { error: { message: e.message } });
            else res.end();
        });
    });

    return {
        server,
        pool,
        settings,
        listen () {
            return new Promise((resolve, reject) => {
                server.once('error', reject);
                server.listen(settings.port, settings.host, () => {
                    pool.startRefresh();
                    resolve(server.address());
                });
            });
        },
        close () {
            pool.save();
            return new Promise(r => server.close(r));
        },
    };
}
