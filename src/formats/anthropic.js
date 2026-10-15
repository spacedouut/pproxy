// Anthropic Messages  <->  Puter chat driver
import { newId } from '../blocks.js';
import {
    sse, functionTool, isWebSearchTool, omitted, dropUndefined, parseJsonArgs, estimateTokens, packDetail, unpackDetail,
} from './common.js';

function imagePart (src) {
    if (src?.type === 'base64') return { type: 'image_url', image_url: { url: `data:${src.media_type};base64,${src.data}` } };
    if (src?.type === 'url') return { type: 'image_url', image_url: { url: src.url } };
    return null;
}

function textPart (b) {
    return dropUndefined({ type: 'text', text: b.text, cache_control: b.cache_control });
}

function toolResultContent (b, extraParts) {
    const prefix = b.is_error ? '[tool error] ' : '';
    if (typeof b.content === 'string') return prefix + b.content;
    const texts = [];
    for (const c of b.content ?? []) {
        if (c.type === 'text') texts.push(c.text);
        else if (c.type === 'image') {
            const img = imagePart(c.source);
            if (img) {
                extraParts.push(img);
                texts.push('[image attached in the next message]');
            }
        }
    }
    return prefix + texts.join('\n');
}

function documentPart (b) {
    if (b.source?.type === 'text') return { type: 'text', text: b.source.data };
    if (b.source?.type === 'content' && Array.isArray(b.source.content)) {
        return { type: 'text', text: b.source.content.filter(c => c.type === 'text').map(c => c.text).join('\n') };
    }
    return omitted(`document${b.title ? ` "${b.title}"` : ''}`);
}

function simplify (parts) {
    if (parts.every(p => p.type === 'text' && !p.cache_control)) return parts.map(p => p.text).join('\n');
    return parts;
}

export function parse (body) {
    const messages = [];

    if (typeof body.system === 'string' && body.system) {
        messages.push({ role: 'system', content: body.system });
    } else if (Array.isArray(body.system) && body.system.length) {
        messages.push({ role: 'system', content: simplify(body.system.filter(b => b.type === 'text').map(textPart)) });
    }

    for (const m of body.messages ?? []) {
        if (typeof m.content === 'string') {
            messages.push({ role: m.role, content: m.content });
            continue;
        }
        if (m.role === 'assistant') {
            const parts = [];
            const toolCalls = [];
            const details = [];
            for (const b of m.content ?? []) {
                if (b.type === 'text' && b.text) parts.push(textPart(b));
                else if (b.type === 'tool_use') {
                    toolCalls.push({ id: b.id, type: 'function', function: { name: b.name, arguments: JSON.stringify(b.input ?? {}) } });
                } else if (b.type === 'thinking') {
                    const packed = unpackDetail(b.signature);
                    if (packed) details.push(packed);
                    else if (b.signature) details.push({ type: 'thinking', thinking: b.thinking, signature: b.signature });
                } else if (b.type === 'redacted_thinking') {
                    details.push({ type: 'redacted_thinking', data: b.data });
                }
            }
            const out = { role: 'assistant', content: parts.length ? simplify(parts) : (toolCalls.length ? null : '') };
            if (toolCalls.length) out.tool_calls = toolCalls;
            if (details.length) out.reasoning_details = details;
            messages.push(out);
            continue;
        }

        const toolMsgs = [];
        const parts = [];
        const extra = [];
        for (const b of m.content ?? []) {
            if (b.type === 'tool_result') {
                toolMsgs.push({ role: 'tool', tool_call_id: b.tool_use_id, content: toolResultContent(b, extra) });
            } else if (b.type === 'text') parts.push(textPart(b));
            else if (b.type === 'image') {
                const img = imagePart(b.source);
                parts.push(img ?? omitted('image'));
            } else if (b.type === 'document') parts.push(documentPart(b));
        }
        messages.push(...toolMsgs);
        const all = [...extra, ...parts];
        if (all.length) messages.push({ role: 'user', content: simplify(all) });
    }

    const tools = [];
    for (const t of body.tools ?? []) {
        if (isWebSearchTool(t.type)) tools.push({ type: 'web_search' });
        else if (t.input_schema && (!t.type || t.type === 'custom')) tools.push(functionTool(t.name, t.description, t.input_schema));
    }

    let toolChoice;
    if (body.tool_choice?.type && tools.length) {
        toolChoice = body.tool_choice.type === 'tool'
            ? { type: 'tool', name: body.tool_choice.name }
            : { type: body.tool_choice.type };
    }

    let thinking;
    if (body.thinking?.type) {
        thinking = dropUndefined({ type: body.thinking.type, budgetTokens: body.thinking.budget_tokens, display: body.thinking.display });
    }

    const of = body.output_format;

    return {
        stream: !!body.stream,
        args: dropUndefined({
            model: body.model,
            messages,
            max_tokens: body.max_tokens,
            temperature: body.temperature,
            tools: tools.length ? tools : undefined,
            tool_choice: toolChoice,
            parallel_tool_calls: body.tool_choice?.disable_parallel_tool_use ? false : undefined,
            stopSequences: body.stop_sequences?.length ? body.stop_sequences : undefined,
            thinking,
            outputFormat: of?.type === 'json_schema' ? dropUndefined({ type: 'json_schema', schema: of.schema }) : undefined,
        }),
    };
}

function usageOut (u) {
    return {
        input_tokens: u.input,
        output_tokens: u.output,
        cache_read_input_tokens: u.cacheRead,
        cache_creation_input_tokens: u.cacheWrite,
    };
}

// Reasoning from non-Claude models has no Anthropic signature; its opaque
// artifact rides in the signature slot so the next turn can replay it.
function thinkingBlock (b) {
    let signature = b.signature ?? '';
    if (!signature && b.detail) signature = packDetailSafe(b.detail);
    return { type: 'thinking', thinking: b.thinking ?? '', signature };
}

function packDetailSafe (d) {
    try { return packDetail(d); } catch { return ''; }
}

function contentBlock (b) {
    switch (b.type) {
    case 'text': return { type: 'text', text: b.text };
    case 'thinking': return thinkingBlock(b);
    case 'redacted_thinking': return { type: 'redacted_thinking', data: b.data };
    case 'tool_use': return { type: 'tool_use', id: b.id, name: b.name, input: parseJsonArgs(b.args) };
    default: return null;
    }
}

export function respond (result, { model }) {
    return {
        id: newId('msg_'),
        type: 'message',
        role: 'assistant',
        model,
        content: result.blocks.map(contentBlock).filter(Boolean),
        stop_reason: result.reasons.anthropic,
        stop_sequence: result.stopSequence ?? null,
        usage: usageOut(result.usage),
    };
}

export async function stream (events, write, { model }) {
    const send = (type, data) => sse(write, type, { type, ...data });
    send('message_start', {
        message: {
            id: newId('msg_'), type: 'message', role: 'assistant', model, content: [],
            stop_reason: null, stop_sequence: null,
            usage: { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
        },
    });
    send('ping', {});

    const idx = new Map();
    let next = 0;
    for await (const ev of events) {
        if (ev.t === 'block_start') {
            const b = ev.block;
            let start;
            if (b.type === 'text') start = { type: 'text', text: '' };
            else if (b.type === 'thinking') start = { type: 'thinking', thinking: '', signature: '' };
            else if (b.type === 'redacted_thinking') start = { type: 'redacted_thinking', data: b.data };
            else if (b.type === 'tool_use') start = { type: 'tool_use', id: b.id, name: b.name, input: {} };
            if (!start) continue;
            idx.set(ev.index, next);
            send('content_block_start', { index: next++, content_block: start });
        } else if (ev.t === 'delta' && idx.has(ev.index)) {
            const index = idx.get(ev.index);
            if (ev.kind === 'text') send('content_block_delta', { index, delta: { type: 'text_delta', text: ev.value } });
            else if (ev.kind === 'thinking') send('content_block_delta', { index, delta: { type: 'thinking_delta', thinking: ev.value } });
            else if (ev.kind === 'signature') send('content_block_delta', { index, delta: { type: 'signature_delta', signature: ev.value } });
            else if (ev.kind === 'args') send('content_block_delta', { index, delta: { type: 'input_json_delta', partial_json: ev.value } });
        } else if (ev.t === 'block_stop' && idx.has(ev.index)) {
            const index = idx.get(ev.index);
            if (ev.block.type === 'thinking' && !ev.block.signature && ev.block.detail) {
                send('content_block_delta', { index, delta: { type: 'signature_delta', signature: packDetailSafe(ev.block.detail) } });
            }
            send('content_block_stop', { index });
        } else if (ev.t === 'done') {
            send('message_delta', {
                delta: { stop_reason: ev.reasons.anthropic, stop_sequence: ev.stopSequence ?? null },
                usage: usageOut(ev.usage),
            });
            send('message_stop', {});
        } else if (ev.t === 'error') {
            send('error', { error: { type: ev.error.status === 429 ? 'rate_limit_error' : 'api_error', message: ev.error.message } });
        }
    }
}

export function countTokens (body) {
    return { input_tokens: estimateTokens([body.system, body.messages, body.tools]) };
}

export function errorBody (status, message) {
    const type = {
        400: 'invalid_request_error', 401: 'authentication_error', 403: 'permission_error',
        404: 'not_found_error', 429: 'rate_limit_error', 529: 'overloaded_error',
    }[status] ?? 'api_error';
    return { type: 'error', error: { type, message } };
}
