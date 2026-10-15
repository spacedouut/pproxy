export class HttpError extends Error {
    constructor (status, message, code) {
        super(message);
        this.status = status;
        this.code = code;
    }
}

export function sse (write, event, data) {
    write(`${event ? `event: ${event}\n` : ''}data: ${typeof data === 'string' ? data : JSON.stringify(data)}\n\n`);
}

export function parseJsonArgs (s) {
    if (!s) return {};
    try {
        return JSON.parse(s);
    } catch {
        return {};
    }
}

// The driver takes Anthropic-style tool choice objects.
export function openaiToolChoice (tc) {
    if (tc == null) return undefined;
    if (typeof tc === 'string') return { auto: { type: 'auto' }, none: { type: 'none' }, required: { type: 'any' } }[tc];
    const name = tc.function?.name ?? tc.name;
    if (name) return { type: 'tool', name };
    return undefined;
}

export function functionTool (name, description, parameters, strict) {
    const fn = { name, parameters: parameters ?? { type: 'object', properties: {} } };
    if (description) fn.description = description;
    if (strict !== undefined) fn.strict = strict;
    return { type: 'function', function: fn };
}

export function isWebSearchTool (type) {
    return typeof type === 'string' && type.startsWith('web_search');
}

export const omitted = (what) => ({ type: 'text', text: `[${what} omitted: not supported through pproxy]` });

export function dropUndefined (obj) {
    for (const k of Object.keys(obj)) if (obj[k] === undefined) delete obj[k];
    return obj;
}

// Opaque reasoning artifacts are carried through formats that have no slot
// for them (an Anthropic signature inside an OpenAI reasoning item, etc.).
const PACK_PREFIX = 'pprox1.';
export const packDetail = (d) => PACK_PREFIX + Buffer.from(JSON.stringify(d)).toString('base64url');
export function unpackDetail (s) {
    if (typeof s !== 'string' || !s.startsWith(PACK_PREFIX)) return null;
    try {
        return JSON.parse(Buffer.from(s.slice(PACK_PREFIX.length), 'base64url').toString());
    } catch {
        return null;
    }
}

export function reasoningDetailsOf (blocks) {
    const out = [];
    for (const b of blocks) {
        if (b.type === 'thinking' && b.signature) out.push({ type: 'thinking', thinking: b.thinking, signature: b.signature });
        else if (b.type === 'thinking' && b.detail) out.push(b.detail);
        else if (b.type === 'redacted_thinking') out.push({ type: 'redacted_thinking', data: b.data });
    }
    return out;
}

export function estimateTokens (value) {
    return Math.ceil(JSON.stringify(value ?? '').length / 4);
}
