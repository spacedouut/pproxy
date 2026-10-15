import { createPuter, chatStream, toPuterError, PuterError } from './puter.js';
import { normalizeUsage } from './blocks.js';
import { loadAccounts, saveAccounts } from './store.js';

export const STRATEGIES = {
    'round-robin': 'Rotate through accounts in turn',
    'most-remaining': 'Send to the account with the most monthly credit left',
    'least-busy': 'Send to the account with the fewest requests in flight',
    priority: 'Use accounts in list order, falling to the next when one fails',
    random: 'Pick at random, weighted by each account\'s weight',
};

const RECENT_WINDOW_MS = 5 * 60 * 1000;

function blankStats () {
    return { requests: 0, errors: 0, inputTokens: 0, outputTokens: 0, cost: 0 };
}

export class Pool {
    constructor (settings) {
        this.settings = settings;
        this.accounts = loadAccounts().map(a => ({
            enabled: true,
            weight: 1,
            status: 'ok',
            usage: null,
            ...a,
            stats: { ...blankStats(), ...a.stats },
        }));
        this.runtime = new Map();
        this.rr = 0;
        this.saveTimer = null;
    }

    view (a) {
        const rt = this.runtime.get(a.id);
        const now = Date.now();
        return {
            id: a.id,
            username: a.username,
            enabled: a.enabled,
            weight: a.weight,
            status: a.status,
            lastError: a.lastError ?? null,
            usage: a.usage,
            stats: a.stats,
            inflight: rt?.inflight ?? 0,
            recent: rt ? rt.recent.filter(t => now - t < RECENT_WINDOW_MS).length : 0,
            lastUsed: a.lastUsed ?? null,
            addedAt: a.addedAt,
        };
    }

    list () {
        return this.accounts.map(a => this.view(a));
    }

    find (key) {
        if (!key) return null;
        const k = String(key).toLowerCase();
        return this.accounts.find(a => a.id === key || a.username?.toLowerCase() === k || a.id.startsWith(key)) ?? null;
    }

    save () {
        clearTimeout(this.saveTimer);
        this.saveTimer = null;
        saveAccounts(this.accounts);
    }

    saveSoon () {
        if (!this.saveTimer) this.saveTimer = setTimeout(() => this.save(), 2000);
    }

    rt (a) {
        let rt = this.runtime.get(a.id);
        if (!rt || rt.token !== a.token) {
            rt = { token: a.token, puter: createPuter(a.token), inflight: rt?.inflight ?? 0, recent: rt?.recent ?? [] };
            this.runtime.set(a.id, rt);
        }
        return rt;
    }

    async addToken (token) {
        token = String(token ?? '').trim();
        if (!token) throw new PuterError('missing token', { status: 400 });
        const puter = createPuter(token);
        let user;
        try {
            user = await puter.auth.getUser();
        } catch (e) {
            throw new PuterError(`Puter rejected the token: ${toPuterError(e).message}`, { status: 400 });
        }
        if (!user?.uuid) throw new PuterError('Puter did not return a user for this token', { status: 400 });

        let a = this.accounts.find(x => x.id === user.uuid);
        if (a) {
            Object.assign(a, { token, username: user.username, status: 'ok', lastError: null });
        } else {
            a = {
                id: user.uuid,
                username: user.username,
                token,
                enabled: true,
                weight: 1,
                status: 'ok',
                usage: null,
                stats: blankStats(),
                addedAt: Date.now(),
            };
            this.accounts.push(a);
        }
        this.runtime.set(a.id, { token, puter, inflight: 0, recent: [] });
        this.save();
        await this.refreshUsage(a);
        return this.view(a);
    }

    remove (key) {
        const a = this.find(key);
        if (!a) return false;
        this.accounts = this.accounts.filter(x => x !== a);
        this.runtime.delete(a.id);
        this.save();
        return true;
    }

    update (key, patch) {
        const a = this.find(key);
        if (!a) return null;
        if (typeof patch.enabled === 'boolean') a.enabled = patch.enabled;
        if (Number.isFinite(patch.weight) && patch.weight >= 0) a.weight = patch.weight;
        if (Number.isInteger(patch.position)) {
            this.accounts = this.accounts.filter(x => x !== a);
            const pos = Math.max(0, Math.min(patch.position, this.accounts.length));
            this.accounts.splice(pos, 0, a);
        }
        this.save();
        return this.view(a);
    }

    async refreshUsage (a) {
        try {
            const u = await this.rt(a).puter.auth.getMonthlyUsage();
            const info = u?.allowanceInfo ?? {};
            a.usage = {
                allowance: info.monthUsageAllowance ?? null,
                remaining: info.remaining ?? null,
                unit: info.unit ?? 'microcents',
                updatedAt: Date.now(),
            };
            if (a.status !== 'auth_error') {
                a.status = a.usage.remaining !== null && a.usage.remaining <= 0 ? 'exhausted' : 'ok';
            }
            if (a.status === 'ok') a.lastError = null;
        } catch (e) {
            const pe = toPuterError(e);
            if (pe.unauthorized) a.status = 'auth_error';
            a.lastError = pe.message;
        }
        this.saveSoon();
        return a.usage;
    }

    async refreshAll () {
        await Promise.allSettled(this.accounts.map(a => this.refreshUsage(a)));
    }

    startRefresh () {
        const every = Math.max(30, this.settings.usageRefreshSec || 300) * 1000;
        this.refreshAll();
        this.refreshTimer = setInterval(() => this.refreshAll(), every);
        this.refreshTimer.unref();
    }

    usable () {
        return this.accounts.filter(a => a.enabled && a.status === 'ok');
    }

    order () {
        const list = this.usable();
        if (list.length < 2) return list;
        const now = Date.now();
        const inflight = a => this.runtime.get(a.id)?.inflight ?? 0;
        const recent = a => (this.runtime.get(a.id)?.recent ?? []).filter(t => now - t < RECENT_WINDOW_MS).length;

        switch (this.settings.strategy) {
        case 'most-remaining':
            return [...list].sort((x, y) => (y.usage?.remaining ?? -1) - (x.usage?.remaining ?? -1));
        case 'least-busy':
            return [...list].sort((x, y) =>
                inflight(x) - inflight(y) || recent(x) - recent(y) || (x.lastUsed ?? 0) - (y.lastUsed ?? 0));
        case 'priority':
            return list;
        case 'random': {
            const pool = [...list];
            const out = [];
            while (pool.length) {
                const total = pool.reduce((s, a) => s + (a.weight || 0), 0);
                let r = Math.random() * total;
                let i = total > 0 ? pool.findIndex(a => (r -= a.weight || 0) < 0) : 0;
                if (i < 0) i = pool.length - 1;
                out.push(pool.splice(i, 1)[0]);
            }
            return out;
        }
        case 'round-robin':
        default: {
            const start = this.rr++ % list.length;
            return [...list.slice(start), ...list.slice(0, start)];
        }
        }
    }

    noteError (a, pe) {
        a.stats.errors += 1;
        a.lastError = pe.message;
        if (pe.unauthorized) a.status = 'auth_error';
        else if (pe.exhausted) a.status = 'exhausted';
        this.saveSoon();
    }

    // Picks an account, starts the request, and waits for the first chunk so
    // errors that happen before any output can fail over to the next account.
    async open (args, { pin } = {}) {
        let order;
        if (pin) {
            const a = this.find(pin);
            if (!a) throw new PuterError(`no account matches "${pin}"`, { status: 400 });
            order = [a];
        } else {
            order = this.order();
            if (!this.settings.failover) order = order.slice(0, 1);
        }
        if (!order.length) {
            throw new PuterError('no usable Puter accounts. Add one with `pprox accounts add` or the web UI.', { status: 503, code: 'no_accounts' });
        }

        let lastErr;
        for (const a of order) {
            const rt = this.rt(a);
            rt.inflight += 1;
            rt.recent = [...rt.recent.filter(t => Date.now() - t < RECENT_WINDOW_MS), Date.now()];
            a.lastUsed = Date.now();
            a.stats.requests += 1;
            const gen = chatStream(rt.puter, args);
            let first;
            try {
                first = await gen.next();
            } catch (e) {
                rt.inflight -= 1;
                const pe = toPuterError(e);
                this.noteError(a, pe);
                lastErr = pe;
                if (!pin && pe.accountLevel) continue;
                pe.account = a.username;
                throw pe;
            }
            return { account: this.view(a), chunks: this.track(a, rt, first, gen) };
        }
        lastErr.account = 'all';
        throw lastErr;
    }

    async * track (a, rt, first, gen) {
        const observe = (c) => {
            if (c?.type === 'usage') {
                const u = normalizeUsage(c);
                a.stats.inputTokens += u.input + u.cacheRead + u.cacheWrite;
                a.stats.outputTokens += u.output;
                a.stats.cost += u.cost;
                if (a.usage?.remaining != null) a.usage.remaining -= u.cost;
            } else if (c?.type === 'error') {
                this.noteError(a, toPuterError(c));
            }
        };
        try {
            if (!first.done) {
                observe(first.value);
                yield first.value;
            }
            for await (const c of gen) {
                observe(c);
                yield c;
            }
        } catch (e) {
            this.noteError(a, toPuterError(e));
            throw e;
        } finally {
            rt.inflight -= 1;
            this.saveSoon();
        }
    }
}
