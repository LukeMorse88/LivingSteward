import { EventEmitter } from 'node:events';
import { readFileSync, writeFileSync, appendFileSync, existsSync, mkdirSync, readdirSync, renameSync, copyFileSync } from 'node:fs';
import { join, resolve, dirname, sep, basename } from 'node:path';
import { randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { makeClient } from './llm.mjs';
import { runTurn, compactHistory, runSubagent, estimateTokens } from './loop.mjs';

const rid = () => randomUUID();
const KW_L3 = ['密码', '身份证', '银行卡', '病历', '诊断', '余额', '工资', '验证码', '私钥'];
const READ_TOOLS = new Set(['read_file', 'list_dir', 'plugin__think-tank__recall']);
const PERSIST = new Set(['user', 'text', 'note', 'error', 'dispatch', 'sys', 'cmd']);

const CLOUD_SYSTEM = `你是 Living Steward 的云端监督脑（顶层 Agent）。你只监督，不执行：
- 职责：理解用户目标 → 任务分解 → 用 dispatch 把子任务派发给本地执行脑；仅当写操作目标不明或多种合理解释代价不同时才 ask_user。
- 读取/探索类请求（如「读一下C盘」「看看桌面有什么」）不要反问、不要说「我不能」：直接 dispatch 最合理的第一步只读子任务（如 list_dir C:\\），结果用户在本地面板看。
- 你没有任何执行工具：不写文件、不跑命令、看不到本地细节。上行只回状态位（成功/失败），隐私数据一律不出本机。
- 你可以开发软件自身：把完整插件代码（plugin.json + index.mjs）或 core 修改写进 dispatch 子任务正文，本地执行脑会落盘并热重载；你自己不写盘。
- 输出简洁中文；分解用表格（步骤/子任务/完成标准）。收到状态汇报后继续派发下一步或向用户总结。`;

const LOCAL_SYSTEM = `你是 Living Steward 的本地执行脑（底层 Agent），在本机用工具完成子任务。
- 必须实际调用工具执行；禁止未执行就汇报成功。
- 手脚全部来自插件：shell、read_file、write_file、list_dir、undo_file、task（子Agent）、self_*（开发自身）、MCP 与插件工具。shell 已在 PowerShell 内：直接写命令体，禁止嵌套 powershell/pwsh -Command。
- 工作区内写自由；工作区外写被内核禁止；工作区外读在 suggest 模式需批准。敏感词（L3）被内核否决时停止并说明，不要绕过。
- 开发自身：self_write 写 plugins/<名>/plugin.json+index.mjs 后 plugin_reload 即生效；改 core 后 /restart。契约见技能 /self-dev。
- 所有细节只留本机；完成后只汇报一句状态（成功/失败+原因概述）。`;

const SUB_SYSTEM = `你是子Agent，独立上下文调查一个子问题。可用工具与主执行脑相同（除 task）。完成后只输出结论摘要：发现、证据路径、建议。不要流水账。`;

const DEFAULT_RULES = [
  { pattern: 'tool:read_file', action: 'allow', note: '只读' },
  { pattern: 'tool:list_dir', action: 'allow', note: '只读' },
  { pattern: 'tool:shell', action: 'allow', note: 'full-auto 默认' },
  { pattern: 'tool:write_file', action: 'allow', note: '工作区内写' },
  { pattern: 'tool:undo_file', action: 'allow', note: '回滚' },
  { pattern: 'tool:task', action: 'allow', note: '子Agent（内部仍过闸门）' },
  { pattern: 'tool:self_*', action: 'allow', note: '开发自身' },
  { pattern: 'tool:plugin_reload', action: 'allow', note: '热重载' },
  { pattern: 'tool:mcp__*', action: 'allow', note: 'MCP' },
  { pattern: 'tool:plugin__*', action: 'allow', note: '插件' },
];

class ToolRegistry {
  constructor() { this.map = new Map(); }
  register(spec, handler) { this.map.set(spec.name, { spec, handler }); }
  registerDefs(defs, handler) { for (const d of defs) this.register(d.function, (a) => handler(d.function.name, a)); }
  defs() { return [...this.map.values()].map(({ spec }) => ({ type: 'function', function: spec })); }
  has(name) { return this.map.has(name); }
  validate(name, args) {
    const { spec } = this.map.get(name);
    const p = spec.parameters ?? { type: 'object', properties: {} };
    for (const k of p.required ?? []) if (args[k] === undefined || args[k] === null) return `缺少必填参数 ${k}`;
    for (const [k, v] of Object.entries(args)) {
      const t = p.properties?.[k]?.type;
      if (!t) continue;
      const ok = t === 'string' ? typeof v === 'string'
        : t === 'number' || t === 'integer' ? typeof v === 'number'
        : t === 'boolean' ? typeof v === 'boolean'
        : t === 'array' ? Array.isArray(v)
        : t === 'object' ? typeof v === 'object' && !Array.isArray(v) : true;
      if (!ok) return `参数 ${k} 类型应为 ${t}`;
    }
    return null;
  }
  async run(name, args, ctx) {
    const rec = this.map.get(name);
    if (!rec) return `未知工具：${name}`;
    const err = this.validate(name, args ?? {});
    if (err) return `参数错误：${err}`;
    try { return String((await rec.handler(args ?? {}, ctx)) ?? '(空结果)'); }
    catch (e) { return `工具错误：${e.message || e}`; }
  }
}

class CommandRegistry {
  constructor() { this.map = new Map(); }
  register(def, handler, ctx) { this.map.set(def.name, { ...def, handler, ctx }); }
  get(name) { return this.map.get(name); }
  list() { return [...this.map.values()].map(({ name, description, usage, scope, plugin }) => ({ name, description, usage, scope, plugin })); }
}

class SkillRegistry {
  constructor() { this.map = new Map(); }
  register(s) { this.map.set(s.name, s); }
  get(name) { return this.map.get(name); }
  list() { return [...this.map.values()]; }
}

class HookRegistry {
  constructor() { this.map = new Map(); }
  register(event, fn) { (this.map.get(event) ?? this.map.set(event, []).get(event)).push(fn); }
  async run(event, payload) {
    for (const fn of this.map.get(event) ?? []) {
      const r = await fn(payload);
      if (r?.block) return r;
    }
    return null;
  }
}

class Gate {
  constructor(file, auditFile) { this.file = file; this.auditFile = auditFile; this.reload(); }
  reload() {
    this.meta = JSON.parse(readFileSync(this.file, 'utf8'));
    this.rules = this.meta.workspaces.find((w) => w.id === this.meta.active).rules;
  }
  scan(t) { for (const kw of KW_L3) if (String(t).includes(kw)) return kw; return null; }
  decide(name, hay, { mode, pathKind }) {
    const l3 = this.scan(hay);
    if (l3) return { action: 'deny', pattern: `privacy:L3:${l3}` };
    if (pathKind === 'out-write') return { action: 'deny', pattern: 'workspace:write-out' };
    if (mode === 'plan' && !READ_TOOLS.has(name)) return { action: 'deny', pattern: 'mode:plan' };
    const rule = this.rules.find((r) => {
      if (!r.pattern.startsWith('tool:')) return false;
      const p = r.pattern.slice(5);
      return p.endsWith('*') ? name.startsWith(p.slice(0, -1)) : name === p;
    });
    if (rule?.action === 'deny') return { action: 'deny', pattern: rule.pattern };
    if (mode === 'full-auto') return { action: 'allow', pattern: rule?.pattern ?? 'mode:full-auto' };
    if (mode === 'auto-edit' && (name === 'write_file' || name === 'undo_file') && pathKind === 'in') return { action: 'allow', pattern: rule?.pattern ?? 'mode:auto-edit' };
    if (pathKind === 'out-read') return { action: 'hold', pattern: 'workspace:read-out' };
    return { action: rule?.action === 'allow' ? 'allow' : 'hold', pattern: rule?.pattern ?? null };
  }
  audit(rec) { appendFileSync(this.auditFile, JSON.stringify({ ts: Date.now(), ...rec }) + '\n'); }
}

class SessionStore {
  constructor(dir) { this.dir = dir; this.file = join(dir, 'sessions.json'); this.idx = existsSync(this.file) ? JSON.parse(readFileSync(this.file, 'utf8')) : { active: {}, sessions: [] }; }
  save() { writeFileSync(this.file, JSON.stringify(this.idx, null, 2)); }
  rollout(id) { return join(this.dir, `rollout-${id}.jsonl`); }
  migrate() {
    for (const role of ['cloud', 'local']) {
      if (this.idx.active[role]) continue;
      const id = 's-' + randomUUID().slice(0, 8);
      const legacy = join(this.dir, `${role}.jsonl`);
      if (existsSync(legacy)) renameSync(legacy, this.rollout(id));
      this.idx.active[role] = id;
      this.idx.sessions.push({ id, role, created: Date.now(), title: '历史会话' });
    }
    this.save();
  }
  active(role) {
    if (!this.idx.active[role]) { this.create(role, '新会话'); }
    return this.idx.active[role];
  }
  create(role, title) {
    const id = 's-' + randomUUID().slice(0, 8);
    this.idx.sessions.push({ id, role, created: Date.now(), title });
    this.idx.active[role] = id;
    this.save();
    return id;
  }
  fork(role) {
    const src = this.rollout(this.active(role));
    const id = this.create(role, '分支·' + (this.idx.sessions.find((s) => s.id === this.idx.active[role])?.title ?? ''));
    if (existsSync(src)) copyFileSync(src, this.rollout(id));
    return id;
  }
  resume(role, id) {
    if (!this.idx.sessions.some((s) => s.id === id && s.role === role)) throw new Error(`会话不存在：${id}`);
    this.idx.active[role] = id;
    this.save();
  }
  append(role, msg) { appendFileSync(this.rollout(this.active(role)), JSON.stringify(msg) + '\n'); }
  read(role) {
    const f = this.rollout(this.active(role));
    if (!existsSync(f)) return [];
    return readFileSync(f, 'utf8').split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l));
  }
  list(role) { return this.idx.sessions.filter((s) => !role || s.role === role); }
  setTitle(role, title) {
    const s = this.idx.sessions.find((x) => x.id === this.idx.active[role]);
    if (s && s.title === '新会话') { s.title = title.slice(0, 30); this.save(); }
  }
}

class Agent {
  constructor(k, role) { this.k = k; this.role = role; this.hist = []; this.llm = []; this.busy = false; this.queue = []; this.controller = null; this.tc = 0; this.compactState = { count: 0 }; this.load(); }
  load() {
    this.hist = []; this.llm = [];
    for (const m of this.k.session.read(this.role)) {
      this.hist.push(m);
      if (m.kind === 'user') this.llm.push({ role: 'user', content: m.text });
      if (m.kind === 'text') this.llm.push({ role: 'assistant', content: m.text });
      if (m.kind === 'note') this.llm.push({ role: 'user', content: m.text });
    }
  }
  system() {
    const k = this.k;
    if (this.role === 'cloud') return CLOUD_SYSTEM + `\n[当前时间] ${new Date().toLocaleString('zh-CN')}`;
    let s = LOCAL_SYSTEM + `\n[工作区] ${k.workspace}\n[审批模式] ${k.mode}`;
    const md = join(k.workspace, 'STEWARD.md');
    if (existsSync(md)) s += `\n[工作区常驻指令 STEWARD.md]\n${readFileSync(md, 'utf8').trim().slice(0, 4000)}`;
    const skills = k.regs.skills.list();
    if (skills.length) s += `\n[技能（/名称 调用）]\n${skills.map((x) => `/${x.name}: ${x.description}`).join('\n')}`;
    return s + `\n[当前时间] ${new Date().toLocaleString('zh-CN')}`;
  }
  send(text) {
    this.k.push(this.role, { id: rid(), kind: 'user', text, queued: this.busy, ts: Date.now() });
    this.k.session.setTitle(this.role, text);
    if (this.busy) this.queue.push(text);
    else { this.llm.push({ role: 'user', content: text }); this.kick(); }
  }
  async kick() {
    if (this.busy) return;
    this.busy = true; this.tc = 0;
    for (const t of this.queue.splice(0)) this.llm.push({ role: 'user', content: t });
    this.controller = new AbortController();
    this.k.emitEvent({ type: 'status', role: this.role, busy: true });
    let reason = 'error';
    try {
      if (this.role === 'local') await this.k.resolveLocal();
      const res = await runTurn({
        client: this.k.client(this.role),
        system: this.system(),
        messages: this.llm,
        tools: this.k.toolsView(this.role),
        callTool: (n, a) => this.k.callTool(this.role, n, a),
        onDelta: (t) => this.k.emitEvent({ type: 'delta', role: this.role, text: t }),
        signal: this.controller.signal,
        maxSteps: this.role === 'cloud' ? 12 : 16,
        drainQueue: () => this.queue.splice(0),
        compact: this.role === 'local' ? (msgs) => compactHistory({ messages: msgs, aux: this.k.speed, state: this.compactState, onNote: (t) => this.k.push('local', { id: rid(), kind: 'sys', text: t, ts: Date.now() }) }) : undefined,
      });
      reason = res.reason;
      if (res.text) this.k.push(this.role, { id: rid(), kind: 'text', text: res.text, ts: Date.now() });
      if (reason === 'steps') this.k.push(this.role, { id: rid(), kind: 'error', text: '达到单轮步数上限，已停下。', ts: Date.now() });
      if (reason === 'aborted') this.k.push(this.role, { id: rid(), kind: 'sys', text: '已中止本轮。', ts: Date.now() });
    } catch (e) {
      this.k.push(this.role, { id: rid(), kind: 'error', text: String(e.message || e), ts: Date.now() });
    } finally {
      this.busy = false; this.controller = null;
      this.k.emitEvent({ type: 'status', role: this.role, busy: false });
      if (this.role === 'local') {
        if (this.k.currentRoute) {
          const ok = reason === 'completed' && this.tc > 0;
          const sub = this.k.currentRoute;
          this.k.currentRoute = null;
          this.k.noteCloud(`【状态汇报】子任务「${sub.slice(0, 60)}」→ ${ok ? '成功' : reason === 'aborted' ? '失败(被中止)' : '失败'}。无细节。`);
        }
        this.k.pumpRoute();
      }
      if (this.queue.length) this.kick();
    }
  }
  abort() { this.controller?.abort(); this.k.resolvePending(this.role); this.queue.length = 0; }
  compactNow() { return compactHistory({ messages: this.llm, aux: this.k.speed, state: this.compactState, onNote: (t) => this.k.push(this.role, { id: rid(), kind: 'sys', text: t, ts: Date.now() }) }); }
}

async function loadPlugins(dir, makeCtx) {
  const regs = { tools: new ToolRegistry(), commands: new CommandRegistry(), skills: new SkillRegistry(), hooks: new HookRegistry(), services: new Map(), toolScope: new Map(), names: [], manifests: [] };
  for (const ent of readdirSync(dir, { withFileTypes: true })) {
    if (!ent.isDirectory()) continue;
    const mf = join(dir, ent.name, 'plugin.json');
    if (!existsSync(mf)) continue;
    const manifest = JSON.parse(readFileSync(mf, 'utf8'));
    const mod = await import(pathToFileURL(join(dir, ent.name, manifest.main ?? 'index.mjs')).href + '?t=' + Date.now());
    await mod.setup(makeCtx(manifest, regs));
    regs.names.push(manifest.name);
    regs.manifests.push(manifest);
  }
  return regs;
}

export class Steward extends EventEmitter {
  constructor(root) {
    super();
    this.root = root;
    this.dataDir = join(root, 'data');
    mkdirSync(this.dataDir, { recursive: true });
    this.pluginsDir = join(root, 'plugins');
    mkdirSync(this.pluginsDir, { recursive: true });
    this.whitelistFile = join(root, 'whitelist.json');
    this.configFile = join(this.dataDir, 'config.json');
    this.initWorkspaces();
    this.gate = new Gate(this.whitelistFile, join(root, 'audit.jsonl'));
    this.session = new SessionStore(this.dataDir);
    this.session.migrate();
    this.config = existsSync(this.configFile) ? JSON.parse(readFileSync(this.configFile, 'utf8')) : { approval: 'full-auto' };
    this.asks = new Map();
    this.approvals = new Map();
    this.routeQueue = [];
    this.currentRoute = null;
    const keyFile = join(this.root, 'deepseek.key');
    const key = process.env.DEEPSEEK_API_KEY ?? (existsSync(keyFile) ? readFileSync(keyFile, 'utf8').trim() : readFileSync(join(homedir(), '.dsh', '.credentials.yaml'), 'utf8').match(/DEEPSEEK_API_KEY:\s*(\S+)/)[1]);
    this.cloud = makeClient({ baseURL: 'https://api.deepseek.com/v1', apiKey: key, model: 'deepseek-chat' });
    this.local = makeClient({ baseURL: 'http://127.0.0.1:8080/v1', apiKey: 'steward-local', model: 'qwen3.6-35b-a3b' });
    this.speed = makeClient({ baseURL: 'http://127.0.0.1:8081/v1', apiKey: 'steward-local', model: 'qwen-speed' });
    this.agents = { cloud: new Agent(this, 'cloud'), local: new Agent(this, 'local') };
    this.kernelFacade = {
      get workspace() { return self.workspace; },
      get mode() { return self.mode; },
      get signal() { return self.agents.local.controller?.signal; },
      root: this.root,
      setMode: (m) => this.setMode(m),
      state: () => this.state(),
      switchWorkspace: (id) => this.switchWorkspace(id),
      addWorkspace: (n, p) => this.addWorkspace(n, p),
      removeWorkspace: (id) => this.removeWorkspace(id),
      saveWhitelist: (r) => this.saveWhitelist(r),
      auditTail: () => this.auditTail(),
      sessions: {
        list: (r) => this.session.list(r),
        resume: (r, id) => { this.session.resume(r, id); this.agents[r].load(); },
        fork: (r) => this.session.fork(r),
        create: (r) => { this.session.create(r, '新会话'); this.agents[r].load(); },
      },
      compact: (r) => this.agents[r].compactNow(),
      abort: (r) => this.abort(r),
      inject: (r, t) => this.agents[r].send(t),
      subagent: async (t) => (await runSubagent({ client: this.local, system: this.agents.local.system() + '\n' + SUB_SYSTEM, tools: this.toolsView('sub'), callTool: (n, a) => this.callTool('local', n, a, true), task: t, signal: this.agents.local.controller?.signal })).summary,
      supervise: { ask: (q, o) => this.cloudAsk(q, o), dispatch: (s) => this.cloudDispatch(s) },
      rebuild: () => this.rebuild(),
      restart: () => this.emitEvent({ type: 'restart' }),
      safePath: (p) => this.safePath(p),
    };
    const self = this;
    this.regs = null;
    this.pluginNames = [];
  }

  get workspace() { return this.gate.meta.workspaces.find((w) => w.id === this.gate.meta.active)?.path ?? resolve(this.root, '..'); }
  get mode() { return this.config.approval; }
  get hist() { return { cloud: this.agents.cloud.hist, local: this.agents.local.hist }; }
  get busy() { return { cloud: this.agents.cloud.busy, local: this.agents.local.busy }; }
  get queue() { return { cloud: this.agents.cloud.queue, local: this.agents.local.queue }; }
  get services() { return this.regs.services; }
  client(role) { return role === 'cloud' ? this.cloud : this.local; }

  setMode(m) {
    if (!['suggest', 'auto-edit', 'full-auto', 'plan'].includes(m)) throw new Error(`未知模式：${m}`);
    this.config.approval = m;
    writeFileSync(this.configFile, JSON.stringify(this.config, null, 2));
    this.emitEvent({ type: 'state' });
  }

  initWorkspaces() {
    const wsFile = join(this.root, 'workspace.txt');
    const seedPath = process.env.STEWARD_WORKSPACE ?? (existsSync(wsFile) ? readFileSync(wsFile, 'utf8').trim() : resolve(this.root, '..'));
    if (existsSync(this.whitelistFile)) {
      const j = JSON.parse(readFileSync(this.whitelistFile, 'utf8'));
      if (j.workspaces?.length) return;
      var rules = Array.isArray(j.rules) ? j.rules : DEFAULT_RULES;
    } else rules = DEFAULT_RULES;
    const ws = { id: rid(), name: basename(seedPath) || '工作区', path: seedPath, rules };
    writeFileSync(this.whitelistFile, JSON.stringify({ active: ws.id, workspaces: [ws] }, null, 2));
  }

  writeWorkspaces(mut) {
    const j = { active: this.gate.meta.active, workspaces: this.gate.meta.workspaces.map((w) => ({ ...w })) };
    mut(j);
    writeFileSync(this.whitelistFile, JSON.stringify(j, null, 2));
    this.gate.reload();
    this.emitEvent({ type: 'state' });
  }

  async start() {
    await this.rebuild();
    await this.regs.hooks.run('session-start', { root: this.root });
  }

  async rebuild() {
    this.regs = await loadPlugins(this.pluginsDir, (m, r) => this.makeCtx(m, r));
    for (const s of this.regs.skills.list()) {
      if (this.regs.commands.get(s.name)) continue;
      this.regs.commands.register({ name: s.name, description: `技能：${s.description}`, scope: 'all', plugin: s.plugin }, (rest, ctx, role) => {
        ctx.kernel.inject(role, `[技能 ${s.name}]\n${s.body}\n\n用户请求：${rest || '按技能执行'}`);
        return `技能 /${s.name} 已注入本轮上下文。`;
      }, this.makeCtx({ name: 'kernel', scope: 'all' }, this.regs));
    }
    this.pluginNames = this.regs.names;
  }

  makeCtx(manifest, regs) {
    const self = this;
    const scope = manifest.scope ?? 'local';
    const ctx = {
      plugin: manifest.name,
      dataDir: this.dataDir,
      get workspace() { return self.workspace; },
      get mode() { return self.mode; },
      aux: this.speed,
      emit: (ev) => this.emitEvent(ev),
      kernel: this.kernelFacade,
      registerTool: (spec, fn) => { regs.tools.register(spec, (a) => fn(a, ctx)); regs.toolScope.set(spec.name, scope); },
      registerCommand: (def, fn) => regs.commands.register({ scope: 'all', ...def, plugin: manifest.name }, fn, ctx),
      registerSkill: (s) => regs.skills.register({ ...s, plugin: manifest.name }),
      registerHook: (ev, fn) => regs.hooks.register(ev, (p) => fn(p, ctx)),
      registerService: (n, o) => regs.services.set(n, o),
    };
    return ctx;
  }

  toolsView(role) {
    const defs = this.regs.tools.defs();
    if (role === 'cloud') return defs.filter((d) => this.regs.toolScope.get(d.function.name) === 'cloud');
    if (role === 'sub') return defs.filter((d) => this.regs.toolScope.get(d.function.name) !== 'cloud' && d.function.name !== 'task');
    return defs.filter((d) => this.regs.toolScope.get(d.function.name) !== 'cloud');
  }

  emitEvent(ev) { this.emit('event', ev); }
  push(role, msg) {
    this.agents[role].hist.push(msg);
    if (PERSIST.has(msg.kind)) this.session.append(role, msg);
    this.emitEvent({ type: 'msg', role, msg });
  }
  update(role, id, patch) {
    const m = this.agents[role].hist.find((x) => x.id === id);
    if (m) Object.assign(m, patch);
    this.emitEvent({ type: 'update', role, id, patch });
  }

  state() {
    return {
      hist: this.hist,
      busy: this.busy,
      whitelist: this.gate.rules,
      workspaces: this.gate.meta.workspaces.map(({ id, name, path }) => ({ id, name, path })),
      activeWs: this.gate.meta.active,
      mode: this.mode,
      mcp: this.services.get('mcp')?.config() ?? { servers: [] },
      mcpStatus: this.services.get('mcp')?.status() ?? [],
      plugins: this.pluginNames,
      commands: this.regs.commands.list(),
      skills: this.regs.skills.list().map(({ name, description }) => ({ name, description })),
      workspace: this.workspace,
    };
  }

  send(role, text) { this.agents[role].send(text); }

  async command(role, text) {
    const m = text.trim().match(/^\/(\S+)\s*([\s\S]*)$/);
    const def = m && this.regs.commands.get(m[1]);
    if (!def) { this.push(role, { id: rid(), kind: 'cmd', name: m?.[1] ?? '?', text: `未知命令。/help 查看全部。`, ts: Date.now() }); return; }
    const out = await def.handler(m[2], def.ctx, role);
    this.push(role, { id: rid(), kind: 'cmd', name: def.name, text: String(out), ts: Date.now() });
    return out;
  }

  pumpRoute() {
    if (this.currentRoute || this.busy.local || !this.routeQueue.length) return;
    this.currentRoute = this.routeQueue.shift();
    this.send('local', `【分流·子任务】${this.currentRoute}`);
  }
  noteCloud(text) {
    this.push('cloud', { id: rid(), kind: 'note', text, ts: Date.now() });
    if (this.busy.cloud) this.queue.cloud.push(text);
    else { this.agents.cloud.llm.push({ role: 'user', content: text }); this.agents.cloud.kick(); }
  }

  async resolveLocal() {
    for (const [port, client] of [[8080, this.local], [8081, this.speed]]) {
      const r = await fetch(`http://127.0.0.1:${port}/v1/models`, { signal: AbortSignal.timeout(4000) });
      if (!r.ok) throw new Error(`本地脑 ${port} 不可用：${r.status}`);
      const j = await r.json();
      client.model = j.data[0].id;
    }
  }

  async cloudAsk(question, options) {
    const id = rid();
    this.push('cloud', { id, kind: 'ask', question: String(question ?? ''), options: options ?? [], answer: null, ts: Date.now() });
    const answer = await new Promise((res) => this.asks.set(id, { res, role: 'cloud' }));
    this.update('cloud', id, { answer });
    return `用户回答：${answer}`;
  }
  cloudDispatch(subtask) {
    const s = String(subtask ?? '');
    const l3 = this.gate.scan(s);
    if (l3) {
      this.gate.audit({ role: 'cloud', tool: 'dispatch', rule: `privacy:L3:${l3}`, action: 'deny', outcome: 'rejected' });
      return `分流器否决：子任务含隐私关键词「${l3}」，禁止下行。请改用 ask_user 提示用户在本机处理。`;
    }
    this.gate.audit({ role: 'cloud', tool: 'dispatch', rule: null, action: 'route-local', outcome: 'allowed-once' });
    this.push('cloud', { id: rid(), kind: 'dispatch', text: s, ts: Date.now() });
    this.routeQueue.push(s);
    this.pumpRoute();
    return '已派发（多个子任务按顺序执行）。你只收状态位（成功/失败），看不到细节。继续下一步或等待汇报。';
  }

  pathKindFor(name, args) {
    if (name === 'read_file' || name === 'list_dir') {
      const abs = resolve(this.workspace, String(args?.path ?? '.'));
      return abs === this.workspace || abs.startsWith(this.workspace + sep) ? 'in' : 'out-read';
    }
    if (name === 'write_file' || name === 'undo_file') {
      const abs = resolve(this.workspace, String(args?.path ?? '.'));
      return abs === this.workspace || abs.startsWith(this.workspace + sep) ? 'in' : 'out-write';
    }
    return null;
  }

  async callTool(role, name, args, sub = false) {
    if (role === 'cloud') return this.regs.tools.run(name, args ?? {}, {});
    this.agents.local.tc++;
    const hay = `${name} ${JSON.stringify(args ?? {})}`;
    const rule = this.gate.decide(name, hay, { mode: this.mode, pathKind: this.pathKindFor(name, args) });
    const id = rid();
    this.push('local', { id, kind: 'tool', name, args, sub, output: null, state: 'running', ts: Date.now() });
    const blk = await this.regs.hooks.run('pre-tool', { name, args, role: sub ? 'subagent' : 'local' });
    let outcome;
    if (blk) outcome = 'rejected';
    else if (rule.action === 'allow') outcome = 'allowed-once';
    else if (rule.action === 'deny') outcome = 'rejected';
    else {
      this.update('local', id, { state: 'holding' });
      const allow = await new Promise((res) => this.approvals.set(id, { res, role: 'local' }));
      outcome = allow ? 'allowed-once' : 'rejected';
      this.update('local', id, { decision: outcome });
    }
    this.gate.audit({ role: sub ? 'subagent' : 'local', tool: name, rule: rule.pattern, action: rule.action, outcome, ws: this.gate.meta.active });
    if (outcome === 'rejected') {
      const out = blk ? `钩子否决：${blk.note ?? 'pre-tool hook'}` : `已拒绝（${rule.pattern ?? '人工审批'}）。不要重试该操作。`;
      this.update('local', id, { state: 'done', output: out });
      return out;
    }
    const out = await this.regs.tools.run(name, args ?? {}, {});
    await this.regs.hooks.run('post-tool', { name, args, out });
    this.update('local', id, { state: 'done', output: String(out).slice(0, 2000) });
    return out;
  }

  resolvePending(role) {
    for (const [id, rec] of [...this.asks]) if (rec.role === role) { this.asks.delete(id); rec.res('（用户中止）'); }
    for (const [id, rec] of [...this.approvals]) if (rec.role === role) { this.approvals.delete(id); rec.res(false); }
  }
  abort(role) { this.agents[role].abort(); }

  answerAsk(id, answer) {
    const rec = this.asks.get(id);
    if (rec) { this.asks.delete(id); rec.res(String(answer)); }
  }
  answerApproval(id, allow, always = false) {
    const rec = this.approvals.get(id);
    if (!rec) return;
    this.approvals.delete(id);
    if (allow && always) {
      const m = this.hist.local.find((x) => x.id === id);
      if (m?.name) this.writeWorkspaces((j) => {
        const ws = j.workspaces.find((w) => w.id === j.active);
        if (ws && !ws.rules.some((r) => r.pattern === `tool:${m.name}` && r.action === 'allow')) ws.rules.unshift({ pattern: `tool:${m.name}`, action: 'allow', note: '人工常允许' });
      });
    }
    rec.res(!!allow);
  }

  safePath(p) {
    const abs = resolve(this.workspace, String(p ?? '.'));
    if (abs !== this.workspace && !abs.startsWith(this.workspace + sep)) throw new Error('路径越界：只允许工作区内');
    return abs;
  }

  saveWhitelist(rules) { this.writeWorkspaces((j) => { const ws = j.workspaces.find((w) => w.id === j.active); if (ws) ws.rules = rules; }); }
  switchWorkspace(id) {
    if (!this.gate.meta.workspaces.some((w) => w.id === id)) return this.state();
    this.writeWorkspaces((j) => { j.active = id; });
    this.push('local', { id: rid(), kind: 'sys', text: `工作区切换 → ${this.workspace}`, ts: Date.now() });
    return this.state();
  }
  addWorkspace(name, p) {
    const abs = resolve(String(p ?? '').trim());
    if (!String(p ?? '').trim()) throw new Error('路径不能为空');
    mkdirSync(abs, { recursive: true });
    const ws = { id: rid(), name: String(name ?? '').trim() || basename(abs), path: abs, rules: DEFAULT_RULES.map((r) => ({ ...r })) };
    this.writeWorkspaces((j) => { j.workspaces.push(ws); j.active = ws.id; });
    return this.state();
  }
  removeWorkspace(id) {
    if (id === this.gate.meta.active) throw new Error('不能删除当前工作区');
    if (this.gate.meta.workspaces.length <= 1) throw new Error('至少保留一个工作区');
    this.writeWorkspaces((j) => { j.workspaces = j.workspaces.filter((w) => w.id !== id); });
    return this.state();
  }

  auditTail() {
    const f = join(this.root, 'audit.jsonl');
    if (!existsSync(f)) return [];
    return readFileSync(f, 'utf8').trim().split('\n').slice(-200);
  }
  async saveMcp(cfg) {
    await this.services.get('mcp').save(cfg);
    await this.rebuild();
    return this.services.get('mcp').status();
  }
}

export { estimateTokens };