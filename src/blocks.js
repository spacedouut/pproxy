// Turns Puter's flat ChatResponseChunk stream into block-level events that
// every output format can render: block_start / delta / block_stop / done.
//
// Block shapes (final, on block_stop):
//   { type: 'text', text }
//   { type: 'thinking', thinking, signature?, detail? }   detail = OpenAI reasoning item
//   { type: 'redacted_thinking', data }
//   { type: 'tool_use', id, name, args }                   args = JSON string
//   { type: 'image', url }

export function normalizeUsage (chunk) {
    const d = chunk?.usageDetails ?? {};
    const u = chunk?.usage ?? {};
    const input = d.inputTokens ?? u.input_tokens ?? u.prompt_tokens ?? 0;
    const output = d.outputTokens ?? u.output_tokens ?? u.completion_tokens ?? 0;
    const cacheRead = d.cacheReadTokens ?? u.cache_read_input_tokens ?? u.cached_tokens ?? 0;
    const cacheWrite = (d.cacheWrite5mTokens ?? 0) + (d.cacheWrite1hTokens ?? 0) || (u.cache_creation_input_tokens ?? 0);
    return {
        input,
        output,
        cacheRead,
        cacheWrite,
        reasoning: d.reasoningTokens ?? u.thinking_tokens ?? 0,
        cost: u.cost ?? 0,
    };
}

const TO_ANTHROPIC = { stop: 'end_turn', length: 'max_tokens', tool_calls: 'tool_use', content_filter: 'refusal' };
const ANTHROPIC_REASONS = new Set(['end_turn', 'max_tokens', 'stop_sequence', 'tool_use', 'pause_turn', 'refusal']);
const TO_OPENAI = { end_turn: 'stop', stop_sequence: 'stop', max_tokens: 'length', tool_use: 'tool_calls', refusal: 'content_filter' };

export function finishReasons ({ finish_reason: fr, stopReason: sr }, sawTool) {
    let anthropic = ANTHROPIC_REASONS.has(sr) ? sr : (TO_ANTHROPIC[fr] ?? 'end_turn');
    let openai = TO_OPENAI[sr] ?? (['stop', 'length', 'tool_calls', 'content_filter'].includes(fr) ? fr : 'stop');
    if (sawTool && anthropic === 'end_turn') anthropic = 'tool_use';
    if (sawTool && openai === 'stop') openai = 'tool_calls';
    return { anthropic, openai };
}

export async function * toBlockEvents (chunks) {
    let index = -1;
    let cur = null;
    const toolBlocks = new Map();
    let sawTool = false;
    let finished = false;

    function * open (block) {
        if (cur) yield * close();
        index += 1;
        cur = { ...block, index };
        yield { t: 'block_start', index, block: { ...block } };
    }
    function * close () {
        if (!cur) return;
        const { index: i, ...block } = cur;
        cur = null;
        yield { t: 'block_stop', index: i, block };
    }

    for await (const c of chunks) {
        switch (c?.type) {
        case 'text':
            if (!c.text) break;
            if (cur?.type !== 'text') yield * open({ type: 'text', text: '' });
            cur.text += c.text;
            yield { t: 'delta', index: cur.index, kind: 'text', value: c.text };
            break;
        case 'reasoning_start':
            yield * open({ type: 'thinking', thinking: '' });
            break;
        case 'reasoning':
            if (!c.reasoning) break;
            if (cur?.type !== 'thinking') yield * open({ type: 'thinking', thinking: '' });
            cur.thinking += c.reasoning;
            yield { t: 'delta', index: cur.index, kind: 'thinking', value: c.reasoning };
            break;
        case 'reasoning_detail': {
            const d = c.detail ?? {};
            if (d.type === 'redacted_thinking') {
                yield * open({ type: 'redacted_thinking', data: d.data });
                yield * close();
                break;
            }
            if (cur?.type !== 'thinking') yield * open({ type: 'thinking', thinking: '' });
            if (d.type === 'thinking') {
                if (!cur.thinking && d.thinking) {
                    cur.thinking = d.thinking;
                    yield { t: 'delta', index: cur.index, kind: 'thinking', value: d.thinking };
                }
                if (d.signature) {
                    cur.signature = d.signature;
                    yield { t: 'delta', index: cur.index, kind: 'signature', value: d.signature };
                }
            } else {
                cur.detail = d;
            }
            yield * close();
            break;
        }
        case 'tool_use_start':
            sawTool = true;
            yield * open({ type: 'tool_use', id: c.id, name: c.name, args: '' });
            toolBlocks.set(c.id, cur);
            break;
        case 'tool_input_delta': {
            const b = toolBlocks.get(c.id);
            if (!b || b !== cur || !c.partialJson) break;
            b.args += c.partialJson;
            b.streamed = true;
            yield { t: 'delta', index: b.index, kind: 'args', value: c.partialJson };
            break;
        }
        case 'tool_use': {
            sawTool = true;
            const b = toolBlocks.get(c.id);
            const full = JSON.stringify(c.input ?? {});
            if (b && b === cur) {
                if (!b.streamed) {
                    b.args = full;
                    yield { t: 'delta', index: b.index, kind: 'args', value: full };
                }
                delete b.streamed;
                yield * close();
            } else {
                yield * open({ type: 'tool_use', id: c.id, name: c.name, args: '' });
                cur.args = full;
                yield { t: 'delta', index: cur.index, kind: 'args', value: full };
                yield * close();
            }
            break;
        }
        case 'image': {
            const url = c.image?.image_url?.url;
            if (url) {
                yield * open({ type: 'image', url });
                yield * close();
            }
            break;
        }
        case 'usage':
            yield * close();
            finished = true;
            yield {
                t: 'done',
                usage: normalizeUsage(c),
                reasons: finishReasons(c, sawTool),
                stopSequence: c.stopSequence ?? null,
            };
            break;
        case 'error':
            yield * close();
            yield { t: 'error', error: { message: c.message || 'upstream error', code: c.code, status: c.status } };
            return;
        default:
            break;
        }
    }
    yield * close();
    if (!finished) {
        yield { t: 'done', usage: normalizeUsage({}), reasons: finishReasons({}, sawTool), stopSequence: null };
    }
}

// Drains block events into a complete result for non-streaming responses.
export async function collect (events) {
    const blocks = [];
    let done = null;
    for await (const ev of events) {
        if (ev.t === 'block_stop') blocks.push(ev.block);
        else if (ev.t === 'done') done = ev;
        else if (ev.t === 'error') {
            const e = new Error(ev.error.message);
            e.status = ev.error.status ?? 502;
            e.code = ev.error.code;
            throw e;
        }
    }
    return { blocks, ...done };
}

export function newId (prefix) {
    return `${prefix}${crypto.randomUUID().replace(/-/g, '').slice(0, 24)}`;
}
