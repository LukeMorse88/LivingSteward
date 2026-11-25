export function makeClient({ baseURL, apiKey, model }) {
  const client = {
    model,
    async stream(messages, tools, onDelta, signal) {
      const body = { model: client.model, messages, stream: true };
      if (tools?.length) { body.tools = tools; body.tool_choice = 'auto'; }
      const res = await fetch(baseURL.replace(/\/$/, '') + '/chat/completions', {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
        body: JSON.stringify(body),
        signal,
      });
      if (!res.ok) throw new Error(`${baseURL} → ${res.status}: ${(await res.text()).slice(0, 300)}`);
      const reader = res.body.getReader();
      const dec = new TextDecoder();
      let buf = '';
      let text = '';
      const calls = [];
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        let i;
        while ((i = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, i).trim();
          buf = buf.slice(i + 1);
          if (!line.startsWith('data:')) continue;
          const payload = line.slice(5).trim();
          if (payload === '[DONE]') continue;
          const j = JSON.parse(payload);
          const d = j.choices?.[0]?.delta;
          if (!d) continue;
          if (d.content) { text += d.content; onDelta?.(d.content); }
          if (d.tool_calls) for (const tc of d.tool_calls) {
            const idx = tc.index ?? 0;
            const cur = (calls[idx] ??= { id: tc.id ?? `call_${idx}`, type: 'function', function: { name: '', arguments: '' } });
            if (tc.id) cur.id = tc.id;
            if (tc.function?.name) cur.function.name += tc.function.name;
            if (tc.function?.arguments) cur.function.arguments += tc.function.arguments;
          }
        }
      }
      return { text, calls: calls.filter(Boolean) };
    },
  };
  return client;
}