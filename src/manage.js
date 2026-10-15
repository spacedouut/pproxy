import crypto from 'node:crypto';
import { STRATEGIES } from './pool.js';

const KEEP = 1000;

// Management API under /manage/v1. Every action gets a request id whose
// status can be read back from /manage/v1/request?id=...
export function createManager ({ pool, settings, persist, startLink }) {
    const requests = new Map();

    const masterKey = () => process.env.PPROXY_MASTER_KEY || settings.masterKey || null;

    function authorized (req) {
        const key = masterKey();
        const sent = req.headers['x-master-key'] ?? req.headers.authorization?.replace(/^Bearer\s+/i, '');
        if (!key || !sent) return false;
        const a = Buffer.from(String(sent));
        const b = Buffer.from(key);
        return a.length === b.length && crypto.timingSafeEqual(a, b);
    }

    function fail (status, message) {
        return Object.assign(new Error(message), { status });
    }

    function newRecord (action, params) {
        const rec = {
            request_id: `req_${crypto.randomUUID().replace(/-/g, '')}`,
            action,
            params,
            status: 'pending',
            result: null,
            error: null,
            created_at: new Date().toISOString(),
            finished_at: null,
        };
        requests.set(rec.request_id, rec);
        if (requests.size > KEEP) requests.delete(requests.keys().next().value);
        return rec;
    }

    function settle (rec, err, result) {
        if (rec.status !== 'pending') return;
        rec.finished_at = new Date().toISOString();
        if (err) {
            rec.status = 'failed';
            rec.error = { message: err.message, status: err.status && err.status >= 400 && err.status < 600 ? err.status : 500 };
        } else {
            rec.status = 'succeeded';
            rec.result = result ?? null;
        }
    }

    function account (key) {
        if (!key) throw fail(400, '"account" (id or username) is required');
        const a = pool.find(key);
        if (!a) throw fail(404, `no such account: ${key}`);
        return a;
    }

    const actions = {
        'add-account': async (body, { base, rec }) => {
            if (body.token) return pool.addToken(body.token);
            // No token: hand back a Puter sign-in link; the request settles when the user finishes.
            const link = startLink(body.base || base, (err, acct) => settle(rec, err, acct));
            return { pending: true, url: link.url, state: link.state };
        },
        'remove-account': async (body) => {
            const a = account(body.account);
            pool.remove(a.id);
            return { removed: a.id, username: a.username };
        },
        'change-weight': async (body) => {
            const a = account(body.account);
            const w = Number(body.weight);
            if (!Number.isFinite(w) || w < 0) throw fail(400, '"weight" must be a number >= 0');
            return pool.update(a.id, { weight: w });
        },
        'enable-account': async (body) => pool.update(account(body.account).id, { enabled: true }),
        'disable-account': async (body) => pool.update(account(body.account).id, { enabled: false }),
        'set-strategy': async (body) => {
            if (!STRATEGIES[body.strategy]) throw fail(400, `unknown strategy; pick one of ${Object.keys(STRATEGIES).join(', ')}`);
            settings.strategy = body.strategy;
            persist();
            return { strategy: settings.strategy };
        },
        'refresh-usage': async (body) => {
            if (body.account) {
                const a = account(body.account);
                await pool.refreshUsage(a);
                return pool.view(a);
            }
            await pool.refreshAll();
            return pool.list();
        },
    };

    const redact = (body) => {
        const { token, ...rest } = body ?? {};
        return token ? { ...rest, token: '(redacted)' } : rest;
    };

    // Returns true if it handled the request.
    async function handle (req, res, { p, method, url, readBody, json }) {
        if (!p.startsWith('/manage/')) return false;
        if (!masterKey()) {
            json(res, 503, { error: { message: 'management API is off; set a master key with `pprox manage key` or PPROXY_MASTER_KEY' } });
            return true;
        }
        if (!authorized(req)) {
            json(res, 401, { error: { message: 'invalid or missing master key' } });
            return true;
        }
        const route = p.replace(/^\/manage\/v1/, '');

        if (method === 'GET' && (route === '/request' || route.startsWith('/request/'))) {
            const id = route.startsWith('/request/') ? decodeURIComponent(route.slice('/request/'.length)) : url.searchParams.get('id');
            const rec = id && requests.get(id);
            if (!rec) json(res, 404, { error: { message: id ? `no such request: ${id}` : '"id" is required' } });
            else json(res, 200, rec);
            return true;
        }
        if (method === 'GET' && route === '/requests') {
            const limit = Math.min(KEEP, Number(url.searchParams.get('limit')) || 50);
            json(res, 200, { data: [...requests.values()].reverse().slice(0, limit) });
            return true;
        }
        if (method === 'GET' && route === '/accounts') {
            json(res, 200, { data: pool.list() });
            return true;
        }

        const action = actions[route.slice(1)];
        if (!action || method !== 'POST') {
            json(res, 404, { error: { message: `no management route for ${method} ${p}` } });
            return true;
        }
        if (req.headers['content-length'] && !(req.headers['content-type'] ?? '').includes('application/json')) {
            json(res, 415, { error: { message: 'Content-Type must be application/json' } });
            return true;
        }
        let body;
        try {
            body = await readBody(req);
        } catch (e) {
            json(res, e.status ?? 400, { error: { message: e.message } });
            return true;
        }

        const rec = newRecord(route.slice(1), redact(body));
        const run = action(body, { base: `http://${req.headers.host}`, rec })
            .then(result => {
                if (result?.pending) rec.result = result;
                else settle(rec, null, result);
            }, err => settle(rec, err));

        res.setHeader('X-Request-Id', rec.request_id);
        if (body.async === true || url.searchParams.get('async') === '1') {
            json(res, 202, rec);
            return true;
        }
        await run;
        json(res, rec.status === 'failed' ? rec.error.status : rec.status === 'pending' ? 202 : 200, rec);
        return true;
    }

    return { handle, requests };
}
