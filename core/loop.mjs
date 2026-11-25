const TRANSIENT = /429|500|502|503|504|ECONNRESET|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|fetch failed|socket|network/i;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function runTurn({ client, system, messages, tools, callTool, onDelta, signal, maxSteps = 16, drainQueue, compact }) {
  for (let step = 0; step < maxSteps; step++) {
    if (signal?.aborted) return { reason: 'aborted', text: '' };
    if (compact) await compact(messages);
    let res;
    for (let attempt = 0; ; attempt++) {
      try {
        res = await client.stream([{ role: 'system', content: system }, ...messages], tools, onDelta, signal);
        break;
      } catch (e) {
        if (signal?.aborted) return { reason: 'aborted', text: '' };
        if (attempt >= 2 || !TRANSIENT.test(String(e?.message || e))) throw e;
        await sleep(1000 * 2 ** attempt);
      }
    }
    const { text, calls } = res;
    if (!calls.length) {
      messages.push({ role: 'assistant', content: text });
      return { reason: 'completed', text };
    }
    messages.push({ role: 'assistant', content: text || '', tool_calls: calls });
    for (const c of calls) {
      if (signal?.aborted) return { reason: 'aborted', text: '' };
      let args;
      let out;
      try { args = JSON.parse(c.function.arguments || '{}'); } catch (e) { out = `参数 JSON 解析失败：${e.message}`; }
      if (out === undefined) out = await callTool(c.function.name, args);
      messages.push({ role: 'tool', tool_call_id: c.id, content: String(out).slice(0, 6000) });
    }
    for (const t of drainQueue?.() ?? []) messages.push({ role: 'user', content: t });
  }
  return { reason: 'steps', text: '' };
}

const LIMIT = 18000;
export function estimateTokens(messages) {
  let n = 0;
  for (const m of messages) {
    n += Math.ceil(String(m.content ?? '').length / 3);
    for (const tc of m.tool_calls ?? []) n += Math.ceil(String(tc.function?.arguments ?? '').length / 3) + 8;
  }
  return n;
}

export async function compactHistory({ messages, aux, state, onNote, keepLast = 6 }) {
  if (estimateTokens(messages) < LIMIT) return false;
  if (state.count >= 2) { onNote?.('本轮压缩已达上限，停止压缩。'); return false; }
  let cut = messages.length - keepLast;
  while (cut > 0 && (messages[cut].role === 'tool' || messages[cut - 1]?.tool_calls)) cut--;
  if (cut <= 0) return false;
  const middle = messages.slice(0, cut);
  const digest = middle.map((m) => `[${m.role}] ${String(m.content ?? '').slice(0, 1500)}${m.tool_calls ? ' tool_calls:' + m.tool_calls.map((t) => t.function.name).join(',') : ''}`).join('\n');
  const res = await aux.stream([
    { role: 'system', content: '你是压缩器。把对话历史压成中文摘要：保留目标、已完成的动作与结果、未决事项、关键路径与数字。只输出摘要。' },
    { role: 'user', content: digest },
  ], [], null, null);
  messages.splice(0, cut, { role: 'user', content: `[历史压缩摘要·替代前 ${cut} 条消息]\n${res.text}` });
  state.count++;
  onNote?.(`历史压缩：${cut} 条 → 摘要（${estimateTokens(messages)} tokens 估）。`);
  return true;
}

export async function runSubagent({ client, system, tools, callTool, task, signal, maxSteps = 10 }) {
  const messages = [{ role: 'user', content: task }];
  const res = await runTurn({ client, system, messages, tools, callTool, signal, maxSteps });
  return { ...res, summary: `[子Agent结论] ${res.text || '(子Agent无输出)'}` };
}