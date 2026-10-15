import { test } from 'node:test';
import assert from 'node:assert/strict';
import { toBlockEvents, collect } from '../src/blocks.js';
import * as chat from '../src/formats/chat.js';
import * as anthropic from '../src/formats/anthropic.js';
import * as responses from '../src/formats/responses.js';

async function * gen (chunks) { for (const c of chunks) yield c; }

const TEXT_AND_TOOL = [
    { type: 'reasoning', reasoning: 'hmm' },
    { type: 'reasoning_detail', detail: { type: 'thinking', thinking: 'hmm', signature: 'sig123' } },
    { type: 'text', text: 'Hel' },
    { type: 'text', text: 'lo' },
    { type: 'tool_use_start', id: 'call_1', name: 'get_weather' },
    { type: 'tool_input_delta', id: 'call_1', partialJson: '{"city":' },
    { type: 'tool_input_delta', id: 'call_1', partialJson: '"Paris"}' },
    { type: 'tool_use', id: 'call_1', name: 'get_weather', input: { city: 'Paris' } },
    { type: 'usage', usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 2 }, stopReason: 'tool_use' },
];

async function streamText (mod, chunks, ctx) {
    let out = '';
    await mod.stream(toBlockEvents(gen(chunks)), (s) => { out += s; }, ctx);
    return out;
}

function sseEvents (raw) {
    return raw.trim().split('\n\n').map(block => {
        const ev = block.match(/^event: (.*)$/m)?.[1] ?? null;
        const data = block.match(/^data: (.*)$/m)[1];
        return { ev, data: data === '[DONE]' ? data : JSON.parse(data) };
    });
}

test('chat: parses system, images, tool calls and tool results', () => {
    const { args, stream } = chat.parse({
        model: 'gpt-x',
        stream: true,
        messages: [
            { role: 'developer', content: 'be brief' },
            { role: 'user', content: [{ type: 'text', text: 'what is this' }, { type: 'image_url', image_url: { url: 'data:image/png;base64,AAA' } }] },
            { role: 'assistant', content: '', tool_calls: [{ id: 'c1', type: 'function', function: { name: 'f', arguments: '{"a":1}' } }] },
            { role: 'tool', tool_call_id: 'c1', content: 'ok' },
        ],
        tools: [{ type: 'function', function: { name: 'f', parameters: { type: 'object' } } }],
        tool_choice: 'required',
        stop: 'END',
        max_completion_tokens: 50,
    });
    assert.equal(stream, true);
    assert.equal(args.messages[0].role, 'system');
    assert.deepEqual(args.messages[1].content[1], { type: 'image_url', image_url: { url: 'data:image/png;base64,AAA' } });
    assert.equal(args.messages[2].content, null);
    assert.equal(args.messages[2].tool_calls[0].function.arguments, '{"a":1}');
    assert.deepEqual(args.messages[3], { role: 'tool', tool_call_id: 'c1', content: 'ok' });
    assert.deepEqual(args.tool_choice, { type: 'any' });
    assert.deepEqual(args.stopSequences, ['END']);
    assert.equal(args.max_tokens, 50);
});

test('chat: non-stream response', async () => {
    const result = await collect(toBlockEvents(gen(TEXT_AND_TOOL)));
    const r = chat.respond(result, { model: 'gpt-x' });
    const m = r.choices[0].message;
    assert.equal(m.content, 'Hello');
    assert.equal(m.reasoning_content, 'hmm');
    assert.deepEqual(m.tool_calls[0], { id: 'call_1', type: 'function', function: { name: 'get_weather', arguments: '{"city":"Paris"}' } });
    assert.equal(r.choices[0].finish_reason, 'tool_calls');
    assert.equal(r.usage.prompt_tokens, 12);
    assert.equal(r.usage.prompt_tokens_details.cached_tokens, 2);
});

test('chat: stream emits deltas, tool call indexes, usage and DONE', async () => {
    const evs = sseEvents(await streamText(chat, TEXT_AND_TOOL, { model: 'gpt-x', includeUsage: true }));
    assert.equal(evs.at(-1).data, '[DONE]');
    const deltas = evs.slice(0, -1).map(e => e.data.choices[0]?.delta).filter(Boolean);
    assert.equal(deltas.map(d => d.content ?? '').join(''), 'Hello');
    const args = deltas.flatMap(d => d.tool_calls ?? []).map(t => t.function.arguments).join('');
    assert.equal(args, '{"city":"Paris"}');
    assert.ok(deltas.some(d => d.tool_calls?.[0]?.id === 'call_1'));
    assert.equal(evs.at(-3).data.choices[0].finish_reason, 'tool_calls');
    assert.equal(evs.at(-2).data.usage.completion_tokens, 5);
});

test('anthropic: parses system blocks, images, tool_use and tool_result', () => {
    const { args } = anthropic.parse({
        model: 'claude-x',
        max_tokens: 100,
        system: [{ type: 'text', text: 'sys', cache_control: { type: 'ephemeral' } }],
        messages: [
            { role: 'user', content: [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAA' } }, { type: 'text', text: 'hi' }] },
            { role: 'assistant', content: [
                { type: 'thinking', thinking: 't', signature: 's' },
                { type: 'tool_use', id: 'tu1', name: 'f', input: { a: 1 } },
            ] },
            { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu1', content: 'done', is_error: true }, { type: 'text', text: 'next' }] },
        ],
        tools: [{ name: 'f', description: 'd', input_schema: { type: 'object' } }, { type: 'web_search_20250305', name: 'web_search' }],
        tool_choice: { type: 'tool', name: 'f', disable_parallel_tool_use: true },
        thinking: { type: 'enabled', budget_tokens: 2000 },
    });
    assert.equal(args.messages[0].role, 'system');
    assert.equal(args.messages[0].content[0].cache_control.type, 'ephemeral');
    assert.equal(args.messages[1].content[0].image_url.url, 'data:image/png;base64,AAA');
    assert.deepEqual(args.messages[2].reasoning_details, [{ type: 'thinking', thinking: 't', signature: 's' }]);
    assert.equal(args.messages[2].tool_calls[0].function.arguments, '{"a":1}');
    assert.deepEqual(args.messages[3], { role: 'tool', tool_call_id: 'tu1', content: '[tool error] done' });
    assert.equal(args.messages[4].content, 'next');
    assert.equal(args.tools.length, 2);
    assert.deepEqual(args.tools[1], { type: 'web_search' });
    assert.deepEqual(args.tool_choice, { type: 'tool', name: 'f' });
    assert.equal(args.parallel_tool_calls, false);
    assert.deepEqual(args.thinking, { type: 'enabled', budgetTokens: 2000 });
});

test('anthropic: non-stream response', async () => {
    const r = anthropic.respond(await collect(toBlockEvents(gen(TEXT_AND_TOOL))), { model: 'claude-x' });
    assert.deepEqual(r.content.map(b => b.type), ['thinking', 'text', 'tool_use']);
    assert.equal(r.content[0].signature, 'sig123');
    assert.deepEqual(r.content[2].input, { city: 'Paris' });
    assert.equal(r.stop_reason, 'tool_use');
    assert.equal(r.usage.cache_read_input_tokens, 2);
});

test('anthropic: stream event sequence', async () => {
    const evs = sseEvents(await streamText(anthropic, TEXT_AND_TOOL, { model: 'claude-x' }));
    const types = evs.map(e => e.ev);
    assert.equal(types[0], 'message_start');
    assert.equal(types.at(-1), 'message_stop');
    assert.equal(evs.filter(e => e.ev === 'content_block_start').length, 3);
    const json = evs.filter(e => e.data.delta?.type === 'input_json_delta').map(e => e.data.delta.partial_json).join('');
    assert.equal(json, '{"city":"Paris"}');
    assert.ok(evs.some(e => e.data.delta?.type === 'signature_delta' && e.data.delta.signature === 'sig123'));
    assert.equal(evs.find(e => e.ev === 'message_delta').data.delta.stop_reason, 'tool_use');
});

test('anthropic: non-Claude reasoning detail round-trips through the signature slot', async () => {
    const detail = { type: 'reasoning.encrypted', data: 'opaque' };
    const r = anthropic.respond(await collect(toBlockEvents(gen([
        { type: 'reasoning', reasoning: 'x' },
        { type: 'reasoning_detail', detail },
        { type: 'text', text: 'y' },
        { type: 'usage', usage: {} },
    ]))), { model: 'm' });
    const { args } = anthropic.parse({ messages: [{ role: 'assistant', content: r.content }] });
    assert.deepEqual(args.messages[0].reasoning_details, [detail]);
});

test('responses: parses input items, instructions and previous_response_id', async () => {
    const body = {
        model: 'gpt-x',
        instructions: 'sys',
        input: [
            { role: 'user', content: [{ type: 'input_text', text: 'hi' }, { type: 'input_image', image_url: 'https://x/y.png' }] },
            { type: 'function_call', call_id: 'c1', name: 'f', arguments: '{}' },
            { type: 'function_call_output', call_id: 'c1', output: 'ok' },
        ],
        tools: [{ type: 'function', name: 'f', parameters: { type: 'object' } }],
        reasoning: { effort: 'low' },
        max_output_tokens: 9,
    };
    const parsed = responses.parse(body);
    const { args } = parsed;
    assert.equal(args.messages[0].content, 'sys');
    assert.equal(args.messages[1].content[1].image_url.url, 'https://x/y.png');
    assert.equal(args.messages[2].tool_calls[0].id, 'c1');
    assert.equal(args.messages[3].role, 'tool');
    assert.equal(args.reasoning_effort, 'low');
    assert.equal(args.max_tokens, 9);

    const resp = responses.respond(await collect(toBlockEvents(gen(TEXT_AND_TOOL))), { model: 'gpt-x', body, parsed });
    assert.deepEqual(resp.output.map(o => o.type), ['reasoning', 'message', 'function_call']);
    assert.equal(resp.output[1].content[0].text, 'Hello');
    assert.equal(resp.output[2].arguments, '{"city":"Paris"}');
    assert.equal(resp.status, 'completed');

    const next = responses.parse({ previous_response_id: resp.id, input: [{ type: 'function_call_output', call_id: 'call_1', output: '20C' }] });
    const roles = next.args.messages.map(m => m.role);
    assert.deepEqual(roles, ['user', 'assistant', 'tool', 'assistant', 'tool']);
    assert.deepEqual(next.args.messages[3].reasoning_details, [{ type: 'thinking', thinking: 'hmm', signature: 'sig123' }]);
    assert.throws(() => responses.parse({ previous_response_id: 'resp_nope', input: 'x' }), /not found/);
});

test('responses: stream event sequence', async () => {
    const body = { model: 'gpt-x', input: 'hi' };
    const parsed = responses.parse(body);
    const evs = sseEvents(await streamText(responses, TEXT_AND_TOOL, { model: 'gpt-x', body, parsed }));
    const types = evs.map(e => e.ev);
    assert.equal(types[0], 'response.created');
    assert.equal(types.at(-1), 'response.completed');
    assert.equal(evs.filter(e => e.ev === 'response.output_text.delta').map(e => e.data.delta).join(''), 'Hello');
    assert.equal(evs.find(e => e.ev === 'response.function_call_arguments.done').data.arguments, '{"city":"Paris"}');
    const seqs = evs.map(e => e.data.sequence_number);
    assert.deepEqual(seqs, [...seqs].sort((a, b) => a - b));
    assert.equal(evs.at(-1).data.response.output.length, 3);
});
