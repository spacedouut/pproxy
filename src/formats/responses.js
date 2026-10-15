// OpenAI Responses  <->  Puter chat driver
import { newId } from '../blocks.js';
import {
    HttpError, sse, openaiToolChoice, functionTool, isWebSearchTool, omitted, dropUndefined,
    packDetail, unpackDetail,
} from './common.js';

// previous_response_id support: conversation history kept in memory.
const MAX_STORED = 500;
const stored = new Map();

function remember (id, messages) {
    stored.set(id, messages);
    while (stored.size > MAX_STORED) stored.delete(stored.keys().next().value);
}

function convertContent (content) {
    if (typeof content === 'string') return content;
    const parts = [];
    for (const p of content ?? []) {
        if (p.type === 'input_text' || p.type === 'output_text' || p.type === 'text') parts.push({ type: 'text', text: p.text });
        else if (p.type === 'refusal') parts.push({ type: 'text', text: p.refusal });
        else if (p.type === 'input_image') {
            const url = typeof p.image_url === 'string' ? p.image_url : p.image_url?.url;
            parts.push(url ? { type: 'image_url', image_url: { url } } : omitted('image file reference'));
        } else if (p.type === 'input_file') parts.push(omitted(`file ${p.filename ?? ''}`.trim()));
    }
    return parts.every(p => p.type === 'text') ? parts.map(p => p.text).join('\n') : parts;
}

function outputText (output) {
    if (typeof output === 'string') return output;
    return (output ?? []).map(p => p.text ?? '').join('\n');
}

function reasoningDetail (item) {
    return unpackDetail(item.encrypted_content)
        ?? dropUndefined({ type: 'reasoning', id: item.id, encrypted_content: item.encrypted_content, summary: item.summary });
}

export function parse (body) {
    let history = [];
    if (body.previous_response_id) {
        const prev = stored.get(body.previous_response_id);
        if (!prev) throw new HttpError(404, `Previous response with id '${body.previous_response_id}' not found.`, 'previous_response_not_found');
        history = prev.map(m => ({ ...m }));
    }

    const conv = [...history];
    let pendingDetails = [];
    const lastAssistant = () => {
        const last = conv[conv.length - 1];
        if (last?.role === 'assistant') return last;
        const msg = { role: 'assistant', content: null };
        conv.push(msg);
        return msg;
    };
    const flushDetails = (msg) => {
        if (!pendingDetails.length) return;
        msg.reasoning_details = [...(msg.reasoning_details ?? []), ...pendingDetails];
        pendingDetails = [];
    };

    const items = typeof body.input === 'string' ? [{ role: 'user', content: body.input }] : (body.input ?? []);
    for (const item of items) {
        const type = item.type ?? (item.role ? 'message' : undefined);
        if (type === 'message') {
            const role = item.role === 'developer' ? 'system' : item.role;
            const msg = { role, content: convertContent(item.content) };
            if (role === 'assistant') {
                const prev = conv[conv.length - 1];
                if (prev?.role === 'assistant' && prev.content == null && !prev.tool_calls) {
                    prev.content = msg.content;
                    flushDetails(prev);
                    continue;
                }
                flushDetails(msg);
            }
            conv.push(msg);
        } else if (type === 'reasoning') {
            pendingDetails.push(reasoningDetail(item));
        } else if (type === 'function_call') {
            const msg = lastAssistant();
            flushDetails(msg);
            msg.tool_calls = [...(msg.tool_calls ?? []), {
                id: item.call_id, type: 'function', function: { name: item.name, arguments: item.arguments || '{}' },
            }];
        } else if (type === 'function_call_output') {
            conv.push({ role: 'tool', tool_call_id: item.call_id, content: outputText(item.output) });
        }
    }
    if (pendingDetails.length) flushDetails(lastAssistant());

    const messages = body.instructions ? [{ role: 'system', content: body.instructions }, ...conv] : conv;

    const tools = [];
    for (const t of body.tools ?? []) {
        if (t.type === 'function') tools.push(functionTool(t.name, t.description, t.parameters, t.strict));
        else if (isWebSearchTool(t.type)) tools.push({ type: 'web_search' });
    }
    const fmt = body.text?.format;

    return {
        stream: !!body.stream,
        conversation: conv,
        args: dropUndefined({
            model: body.model,
            messages,
            max_tokens: body.max_output_tokens,
            temperature: body.temperature,
            tools: tools.length ? tools : undefined,
            tool_choice: tools.length ? openaiToolChoice(body.tool_choice) : undefined,
            parallel_tool_calls: body.parallel_tool_calls,
            reasoning_effort: body.reasoning?.effort,
            verbosity: body.text?.verbosity,
            outputFormat: fmt?.type === 'json_schema'
                ? dropUndefined({ type: 'json_schema', schema: fmt.schema, name: fmt.name, strict: fmt.strict })
                : undefined,
        }),
    };
}

function reasoningItem (b, id) {
    const detail = b.signature ? { type: 'thinking', thinking: b.thinking, signature: b.signature } : b.detail;
    return dropUndefined({
        type: 'reasoning',
        id,
        summary: b.thinking ? [{ type: 'summary_text', text: b.thinking }] : [],
        encrypted_content: detail ? packDetail(detail) : undefined,
    });
}

const messageItem = (id, text, status = 'completed') => ({
    type: 'message', id, status, role: 'assistant',
    content: [{ type: 'output_text', text, annotations: [], logprobs: [] }],
});

const callItem = (b, id, status = 'completed') => ({
    type: 'function_call', id, call_id: b.id, name: b.name, arguments: b.args || '{}', status,
});

function usageOut (u) {
    const input = u.input + u.cacheRead + u.cacheWrite;
    return {
        input_tokens: input,
        input_tokens_details: { cached_tokens: u.cacheRead },
        output_tokens: u.output,
        output_tokens_details: { reasoning_tokens: u.reasoning },
        total_tokens: input + u.output,
    };
}

function baseResponse (body, ctx, id) {
    return {
        id,
        object: 'response',
        created_at: Math.floor(Date.now() / 1000),
        status: 'in_progress',
        error: null,
        incomplete_details: null,
        instructions: body.instructions ?? null,
        max_output_tokens: body.max_output_tokens ?? null,
        model: ctx.model,
        output: [],
        parallel_tool_calls: body.parallel_tool_calls ?? true,
        previous_response_id: body.previous_response_id ?? null,
        reasoning: body.reasoning ?? { effort: null, summary: null },
        store: body.store !== false,
        temperature: body.temperature ?? 1,
        text: body.text ?? { format: { type: 'text' } },
        tool_choice: body.tool_choice ?? 'auto',
        tools: body.tools ?? [],
        top_p: body.top_p ?? 1,
        truncation: 'disabled',
        usage: null,
        metadata: body.metadata ?? {},
    };
}

function finish (resp, done) {
    const truncated = done.reasons.openai === 'length';
    resp.status = truncated ? 'incomplete' : 'completed';
    resp.incomplete_details = truncated ? { reason: 'max_output_tokens' } : null;
    resp.usage = usageOut(done.usage);
}

// The assistant turn as chat messages, for previous_response_id replay.
function assistantMessage (blocks) {
    const text = blocks.filter(b => b.type === 'text').map(b => b.text).join('');
    const calls = blocks.filter(b => b.type === 'tool_use').map(b => ({
        id: b.id, type: 'function', function: { name: b.name, arguments: b.args || '{}' },
    }));
    const details = blocks.flatMap(b => {
        if (b.type === 'thinking' && b.signature) return [{ type: 'thinking', thinking: b.thinking, signature: b.signature }];
        if (b.type === 'thinking' && b.detail) return [b.detail];
        if (b.type === 'redacted_thinking') return [{ type: 'redacted_thinking', data: b.data }];
        return [];
    });
    const msg = { role: 'assistant', content: text || (calls.length ? null : '') };
    if (calls.length) msg.tool_calls = calls;
    if (details.length) msg.reasoning_details = details;
    return msg;
}

function store (body, parsed, resp, blocks) {
    if (body.store === false) return;
    remember(resp.id, [...parsed.conversation, assistantMessage(blocks)]);
}

export function respond (result, ctx) {
    const { body, parsed } = ctx;
    const resp = baseResponse(body, ctx, newId('resp_'));
    let msg = null;
    for (const b of result.blocks) {
        if (b.type === 'text') {
            if (!msg) {
                msg = messageItem(newId('msg_'), '');
                resp.output.push(msg);
            }
            msg.content[0].text += b.text;
            continue;
        }
        msg = null;
        if (b.type === 'thinking') resp.output.push(reasoningItem(b, newId('rs_')));
        else if (b.type === 'tool_use') resp.output.push(callItem(b, newId('fc_')));
    }
    finish(resp, result);
    store(body, parsed, resp, result.blocks);
    return resp;
}

export async function stream (events, write, ctx) {
    const { body, parsed } = ctx;
    let seq = 0;
    const send = (type, data) => sse(write, type, { type, sequence_number: seq++, ...data });
    const resp = baseResponse(body, ctx, newId('resp_'));
    send('response.created', { response: resp });
    send('response.in_progress', { response: resp });

    const blocks = [];
    const open = new Map();
    for await (const ev of events) {
        if (ev.t === 'block_start') {
            const b = ev.block;
            const output_index = resp.output.length;
            let item;
            if (b.type === 'text') item = messageItem(newId('msg_'), '', 'in_progress');
            else if (b.type === 'thinking') item = { type: 'reasoning', id: newId('rs_'), summary: [] };
            else if (b.type === 'tool_use') item = callItem({ ...b, args: '' }, newId('fc_'), 'in_progress');
            if (!item) continue;
            resp.output.push(item);
            open.set(ev.index, { item, output_index, buf: '' });
            send('response.output_item.added', { output_index, item: structuredClone(item) });
            if (b.type === 'text') {
                send('response.content_part.added', {
                    item_id: item.id, output_index, content_index: 0,
                    part: { type: 'output_text', text: '', annotations: [], logprobs: [] },
                });
            } else if (b.type === 'thinking') {
                send('response.reasoning_summary_part.added', {
                    item_id: item.id, output_index, summary_index: 0, part: { type: 'summary_text', text: '' },
                });
            }
        } else if (ev.t === 'delta' && open.has(ev.index)) {
            const o = open.get(ev.index);
            const base = { item_id: o.item.id, output_index: o.output_index };
            if (ev.kind === 'text') {
                o.buf += ev.value;
                send('response.output_text.delta', { ...base, content_index: 0, delta: ev.value, logprobs: [] });
            } else if (ev.kind === 'thinking') {
                o.buf += ev.value;
                send('response.reasoning_summary_text.delta', { ...base, summary_index: 0, delta: ev.value });
            } else if (ev.kind === 'args') {
                o.buf += ev.value;
                send('response.function_call_arguments.delta', { ...base, delta: ev.value });
            }
        } else if (ev.t === 'block_stop') {
            blocks.push(ev.block);
            const o = open.get(ev.index);
            if (!o) continue;
            open.delete(ev.index);
            const base = { item_id: o.item.id, output_index: o.output_index };
            let done;
            if (ev.block.type === 'text') {
                const text = ev.block.text;
                send('response.output_text.done', { ...base, content_index: 0, text, logprobs: [] });
                const part = { type: 'output_text', text, annotations: [], logprobs: [] };
                send('response.content_part.done', { ...base, content_index: 0, part });
                done = messageItem(o.item.id, text);
            } else if (ev.block.type === 'thinking') {
                done = reasoningItem(ev.block, o.item.id);
                if (ev.block.thinking) {
                    send('response.reasoning_summary_text.done', { ...base, summary_index: 0, text: ev.block.thinking });
                    send('response.reasoning_summary_part.done', {
                        ...base, summary_index: 0, part: { type: 'summary_text', text: ev.block.thinking },
                    });
                }
            } else if (ev.block.type === 'tool_use') {
                send('response.function_call_arguments.done', { ...base, arguments: ev.block.args || '{}' });
                done = callItem(ev.block, o.item.id);
            }
            resp.output[o.output_index] = done;
            send('response.output_item.done', { output_index: o.output_index, item: done });
        } else if (ev.t === 'done') {
            finish(resp, ev);
            store(body, parsed, resp, blocks);
            send(resp.status === 'incomplete' ? 'response.incomplete' : 'response.completed', { response: resp });
        } else if (ev.t === 'error') {
            resp.status = 'failed';
            resp.error = { code: ev.error.code ?? 'server_error', message: ev.error.message };
            send('response.failed', { response: resp });
        }
    }
}

export function getStored (id) {
    return stored.get(id);
}

export function deleteStored (id) {
    return stored.delete(id);
}
