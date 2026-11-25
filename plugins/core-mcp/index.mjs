import { spawn } from 'node:child_process';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { createInterface } from 'node:readline';

class McpHub {
  constructor(file) { this.file = file; this.servers = new Map(); }
  config() { return existsSync(this.file) ? JSON.parse(readFileSync(this.file, 'utf8')) : { servers: [] }; }
  async start() { for (const s of this.config().servers ?? []) await this.connect(s); }
  async stop() { for (const rec of this.servers.values()) rec.proc?.kill(); this.servers.clear(); }
  async restart() { await this.stop(); await this.start(); }
  connect(s) {
    return new Promise((resolve, reject) => {
      const proc = spawn(s.command, s.args ?? [], { env: { ...process.env, ...s.env }, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
      const rec = { proc, pending: new Map(), tools: [], nextId: 1, error: null };
      this.servers.set(s.name, rec);
      const rl = createInterface({ input: proc.stdout });
      rl.on('line', (line) => {
        const m = JSON.parse(line);
        if (m.id !== undefined && rec.pending.has(m.id)) {
          const p = rec.pending.get(m.id);
          rec.pending.delete(m.id);
          m.error ? p.rej(new Error(m.error.message)) : p.res(m.result);
        }
      });
      const rpc = (method, params) => new Promise((res, rej) => {
        const id = rec.nextId++;
        rec.pending.set(id, { res, rej });
        proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
        setTimeout(() => { if (rec.pending.has(id)) { rec.pending.delete(id); rej(new Error('MCP 超时')); } }, 10000);
      });
      rec.rpc = rpc;
      proc.on('error', (e) => { rec.error = String(e.message || e); reject(e); });
      const timer = setTimeout(() => { rec.error = 'MCP 初始化超时'; reject(new Error(rec.error)); }, 10000);
      rpc('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'living-steward', version: '2.0.0' } })
        .then(() => {
          proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
          return rpc('tools/list', {});
        })
        .then((r) => { rec.tools = r.tools ?? []; clearTimeout(timer); resolve(rec); })
        .catch((e) => { clearTimeout(timer); rec.error = String(e.message || e); reject(e); });
    });
  }
  toolDefs() {
    const out = [];
    for (const [name, rec] of this.servers)
      for (const t of rec.tools ?? [])
        out.push({ type: 'function', function: { name: `mcp__${name}__${t.name}`, description: t.description ?? '', parameters: t.inputSchema ?? { type: 'object', properties: {} } } });
    return out;
  }
  async call(full, args) {
    const parts = full.split('__');
    const rec = this.servers.get(parts[1]);
    const r = await rec.rpc('tools/call', { name: parts.slice(2).join('__'), arguments: args });
    return (r.content ?? []).map((c) => c.text ?? '').join('\n') || '(空结果)';
  }
  status() { return [...this.servers].map(([name, rec]) => ({ name, tools: rec.tools?.length ?? 0, error: rec.error })); }
}

let hub = null;
export async function setup(ctx) {
  if (hub) await hub.stop();
  const file = join(ctx.dataDir, 'mcp.json');
  if (!existsSync(file)) writeFileSync(file, JSON.stringify({ servers: [] }, null, 2));
  hub = new McpHub(file);
  await hub.start();
  for (const def of hub.toolDefs()) ctx.registerTool(def.function, (a) => hub.call(def.function.name, a));
  ctx.registerService('mcp', {
    config: () => hub.config(),
    status: () => hub.status(),
    save: async (cfg) => { writeFileSync(file, JSON.stringify(cfg, null, 2)); await hub.restart(); },
  });
}