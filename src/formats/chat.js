// OpenAI Chat Completions  <->  Puter chat driver
import { newId } from '../blocks.js';
import {
    sse, openaiToolChoice, functionTool, isWebSearchTool, omitted, dropUndefined, reasoningDetailsOf,
} from './common.js';

function convertParts (content) {
    if (content == null || typeof content === 'string') return content ?? '';
    const parts = [];
    for (const p of content) {
        if (p.type === 'text') parts.push(dropUndefined({ type: 'text', text: p.text, cache_control: p.cache_control }));
        else if (p.type === 'image_url') {
            const url = typeof p.image_url === 'string' ? p.image_url : p.image_url?.url;
            if (url) parts.push({ type: 'image_url', image_url: { url } });
        } else if (p.type === 'input_audio') parts.push(omitted('audio'));
        else if (p.type === 'file') parts.push(omitted(`file ${p.file?.filename ?? ''}`.trim()));
    }
    return parts;
}

function textOf (content) {
    if (typeof content === 'string') return content;
    return (content ?? []).filter(p => p.type === 'text').map(p => p.text).join('\n');
}

export function parse (body) {
    const messages = [];
    for (const m of body.messages ?? []) {
        if (m.role === 'function') continue;
        const role = m.role === 'developer' ? 'system' : m.role;
        if (role === 'tool') {
            messages.push({ role: 'tool', tool_call_id: m.tool_call_id, content: textOf(m.content) });
            continue;
        }
        const out = { role, content: convertParts(m.content) };
        if (role === 'assistant' && m.tool_calls?.length) {
            out.tool_calls = m.tool_calls.map(tc => ({
                id: tc.id,
                type: 'function',
                function: { name: tc.function?.name, arguments: tc.function?.arguments || '{}' },
            }));
            if (!out.content || (Array.isArray(out.content) && !out.content.length)) out.content = null;
        }
        if (m.reasoning_details) out.reasoning_details = m.reasoning_details;
        if (m.cache_control) out.cache_control = m.cache_control;
        messages.push(out);
    }

    const tools = [];
    for (const t of body.tools ?? []) {
        if (t.type === 'function' && t.function) tools.push(functionTool(t.function.name, t.function.description, t.function.parameters, t.function.strict));
        else if (isWebSearchTool(t.type)) tools.push({ type: 'web_search' });
    }

    const rf = body.response_format;
    const stop = typeof body.stop === 'string' ? [body.stop] : body.stop;

    return {
        stream: !!body.stream,
        includeUsage: !!body.stream_options?.include_usage,
        args: dropUndefined({
            model: body.model,
            messages,
            max_tokens: body.max_completion_tokens ?? body.max_tokens,
            temperature: body.temperature,
            tools: tools.length ? tools : undefined,
            tool_choice: tools.length ? openaiToolChoice(body.tool_choice) : undefined,
            parallel_tool_calls: body.parallel_tool_calls,
            stopSequences: stop?.length ? stop : undefined,
            outputFormat: rf?.type === 'json_schema' && rf.json_schema
                ? dropUndefined({ type: 'json_schema', schema: rf.json_schema.schema, name: rf.json_schema.name, strict: rf.json_schema.strict })
                : undefined,
            reasoning_effort: body.reasoning_effort,
            verbosity: body.verbosity,
        }),
    };
}

function usageOut (u) {
    const prompt = u.input + u.cacheRead + u.cacheWrite;
    return {
        prompt_tokens: prompt,
        completion_tokens: u.output,
        total_tokens: prompt + u.output,
        prompt_tokens_details: { cached_tokens: u.cacheRead },
        completion_tokens_details: { reasoning_tokens: u.reasoning },
    };
}

export function respond (result, { model }) {
    const { blocks } = result;
    const text = blocks.filter(b => b.type === 'text').map(b => b.text).join('');
    const reasoning = blocks.filter(b => b.type === 'thinking').map(b => b.thinking).filter(Boolean).join('\n\n');
    const toolCalls = blocks.filter(b => b.type === 'tool_use').map(b => ({
        id: b.id, type: 'function', function: { name: b.name, arguments: b.args || '{}' },
    }));
    const images = blocks.filter(b => b.type === 'image').map(b => ({ type: 'image_url', image_url: { url: b.url } }));
    const details = reasoningDetailsOf(blocks);

    const message = { role: 'assistant', content: text || (toolCalls.length ? null : '') };
    if (reasoning) message.reasoning_content = reasoning;
    if (details.length) message.reasoning_details = details;
    if (toolCalls.length) message.tool_calls = toolCalls;
    if (images.length) message.images = images;

    return {
        id: newId('chatcmpl-'),
        object: 'chat.completion',
        created: Math.floor(Date.now() / 1000),
        model,
        choices: [{ index: 0, message, finish_reason: result.reasons.openai, logprobs: null }],
        usage: usageOut(result.usage),
    };
}

export async function stream (events, write, { model, includeUsage }) {
    const id = newId('chatcmpl-');
    const created = Math.floor(Date.now() / 1000);
    const chunk = (delta, finish = null) => sse(write, null, {
        id, object: 'chat.completion.chunk', created, model,
        choices: [{ index: 0, delta, finish_reason: finish, logprobs: null }],
    });
    const toolIdx = new Map();

    chunk({ role: 'assistant', content: '' });
    for await (const ev of events) {
        if (ev.t === 'block_start' && ev.block.type === 'tool_use') {
            const i = toolIdx.size;
            toolIdx.set(ev.index, i);
            chunk({ tool_calls: [{ index: i, id: ev.block.id, type: 'function', function: { name: ev.block.name, arguments: '' } }] });
        } else if (ev.t === 'delta') {
            if (ev.kind === 'text') chunk({ content: ev.value });
            else if (ev.kind === 'thinking') chunk({ reasoning_content: ev.value });
            else if (ev.kind === 'args') chunk({ tool_calls: [{ index: toolIdx.get(ev.index), function: { arguments: ev.value } }] });
        } else if (ev.t === 'block_stop') {
            const details = reasoningDetailsOf([ev.block]);
            if (details.length) chunk({ reasoning_details: details });
            if (ev.block.type === 'image') chunk({ images: [{ type: 'image_url', image_url: { url: ev.block.url } }] });
        } else if (ev.t === 'done') {
            chunk({}, ev.reasons.openai);
            if (includeUsage) {
                sse(write, null, { id, object: 'chat.completion.chunk', created, model, choices: [], usage: usageOut(ev.usage) });
            }
        } else if (ev.t === 'error') {
            sse(write, null, { error: { message: ev.error.message, type: 'upstream_error', code: ev.error.code ?? null } });
        }
    }
    sse(write, null, '[DONE]');
}

export function errorBody (status, message, code) {
    const type = status === 401 ? 'authentication_error' : status === 429 ? 'rate_limit_error' : status < 500 ? 'invalid_request_error' : 'api_error';
    return { error: { message, type, code: code ?? null } };
}
