import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

// puter.js copies every global into its sandbox, which touches Node's
// experimental localStorage getter and prints a warning on every init().
const emitWarning = process.emitWarning;
process.emitWarning = function (warning, ...rest) {
    const msg = typeof warning === 'string' ? warning : warning?.message;
    if (msg && msg.includes('localStorage')) return;
    return emitWarning.call(process, warning, ...rest);
};

const { init } = require('@heyputer/puter.js/src/init.cjs');

export const PUTER_GUI = 'https://puter.com';

export function createPuter (token) {
    return init(token);
}

export class PuterError extends Error {
    constructor (message, { status, code, raw } = {}) {
        super(message);
        this.status = status;
        this.code = code;
        this.raw = raw;
    }

    // Problems tied to the account (bad token, out of credit, rate limited)
    // rather than to the request itself. These are worth retrying elsewhere.
    get accountLevel () {
        if ([401, 402, 403, 429].includes(this.status)) return true;
        const s = `${this.code ?? ''} ${this.message}`.toLowerCase();
        return /token_auth_failed|unauthori[sz]ed|insufficient|funds|usage.?limit|allowance|credit|rate.?limit|quota/.test(s);
    }

    get exhausted () {
        if (this.status === 402) return true;
        const s = `${this.code ?? ''} ${this.message}`.toLowerCase();
        return /insufficient|funds|usage.?limit|allowance|credit/.test(s);
    }

    get unauthorized () {
        return this.status === 401 || /token_auth_failed|unauthori[sz]ed/i.test(`${this.code} ${this.message}`);
    }
}

export function toPuterError (e) {
    if (e instanceof PuterError) return e;
    const err = e?.error && typeof e.error === 'object' ? e.error : e;
    const message = (typeof err === 'string' ? err : err?.message) || 'puter request failed';
    const status = err?.status ?? e?.status ?? (typeof err?.code === 'number' ? err.code : undefined);
    return new PuterError(message, { status, code: err?.code, raw: e });
}

// Calls the chat driver and always yields ChatResponseChunk-shaped objects,
// whether Puter streamed or not. We go through puter.drivers.call instead of
// puter.ai.chat because the published SDK drops tool_choice, stopSequences,
// thinking and friends before they reach the wire.
export async function * chatStream (puter, args) {
    let res;
    try {
        res = await puter.drivers.call('puter-chat-completion', 'ai-chat', 'complete', { ...args, stream: true });
    } catch (e) {
        throw toPuterError(e);
    }

    if (res && typeof res[Symbol.asyncIterator] === 'function') {
        let first = true;
        for await (const chunk of res) {
            // An error before any output is thrown so the pool can fail over.
            if (first && (chunk?.success === false || chunk?.type === 'error')) {
                throw toPuterError(chunk.error ?? chunk);
            }
            first = false;
            yield chunk;
        }
        return;
    }

    if (!res || res.success === false || res.error) throw toPuterError(res?.error ?? res);
    yield * resultToChunks(res.result ?? res);
}

function * resultToChunks (result) {
    const msg = result.message ?? {};
    if (msg.reasoning) yield { type: 'reasoning', reasoning: msg.reasoning };
    for (const d of msg.reasoning_details ?? []) yield { type: 'reasoning_detail', detail: d };
    if (typeof msg.content === 'string' && msg.content) {
        yield { type: 'text', text: msg.content };
    } else if (Array.isArray(msg.content)) {
        for (const b of msg.content) {
            if (b.type === 'text') yield { type: 'text', text: b.text };
            else if (b.type === 'tool_use') yield { type: 'tool_use', id: b.id, name: b.name, input: b.input };
        }
    }
    for (const tc of msg.tool_calls ?? []) {
        let input = {};
        try { input = JSON.parse(tc.function?.arguments || '{}'); } catch { input = {}; }
        yield { type: 'tool_use', id: tc.id, name: tc.function?.name, input };
    }
    for (const img of msg.images ?? []) yield { type: 'image', image: img };
    yield {
        type: 'usage',
        usage: result.usage,
        usageDetails: result.usageDetails,
        finish_reason: result.finish_reason,
        stopReason: result.stopReason,
        stopSequence: result.stopSequence,
    };
}
