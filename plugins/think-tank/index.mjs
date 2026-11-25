import { readFileSync, appendFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));

export function setup(ctx) {
  const store = join(ctx.dataDir, 'think-tank.jsonl');
  const rows = () => existsSync(store) ? readFileSync(store, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [];
  const note = (title, content, tags = []) => {
    appendFileSync(store, JSON.stringify({ ts: Date.now(), title, content, tags }) + '\n');
    return `已记入智库「${title}」`;
  };
  const recall = (query, limit = 8) => {
    const all = rows();
    const hit = query
      ? all.map((r) => ({ r, s: (r.title + r.content + r.tags.join()).split(query).length - 1 })).filter((x) => x.s > 0).sort((a, b) => b.s - a.s).map((x) => x.r)
      : all.slice(-limit);
    return hit.slice(0, limit).map((r) => `[${new Date(r.ts).toLocaleString('zh-CN')}] ${r.title}: ${r.content.slice(0, 300)}`).join('\n') || '无命中';
  };
  const deliberate = async (topic) => {
    const res = await ctx.aux.stream([
      { role: 'system', content: '你是智库审议器。对议题输出三段：支持点 / 反对与风险 / 可执行建议+结论。中文，简洁。' },
      { role: 'user', content: topic },
    ], [], null, null);
    note(`审议：${topic.slice(0, 40)}`, res.text, ['审议']);
    return res.text;
  };
  ctx.registerTool({ name: 'plugin__think-tank__note', description: '智库记一条笔记', parameters: { type: 'object', properties: { title: { type: 'string' }, content: { type: 'string' }, tags: { type: 'array', items: { type: 'string' } } }, required: ['title', 'content'] } },
    (a) => note(a.title, a.content, a.tags ?? []));
  ctx.registerTool({ name: 'plugin__think-tank__recall', description: '智库检索（关键词打分，空词返回最近）', parameters: { type: 'object', properties: { query: { type: 'string' }, limit: { type: 'integer' } } } },
    (a) => recall(a.query ?? '', a.limit ?? 8));
  ctx.registerTool({ name: 'plugin__think-tank__deliberate', description: '智库三段审议（支持/反对风险/建议结论），自动归档', parameters: { type: 'object', properties: { topic: { type: 'string' } }, required: ['topic'] } },
    (a) => deliberate(a.topic));
  ctx.registerCommand({ name: 'think-tank', description: '智库审议一个议题', usage: '/think-tank <议题>' }, (rest) => deliberate(rest.trim()));
  ctx.registerCommand({ name: 'recall', description: '智库检索', usage: '/recall <关键词>' }, (rest) => recall(rest.trim()));
  ctx.registerCommand({ name: 'note', description: '智库记笔记', usage: '/note <标题> <内容>' },
    (rest) => {
      const i = rest.trim().indexOf(' ');
      return note(rest.trim().slice(0, i), rest.trim().slice(i + 1));
    });
  ctx.registerSkill({ name: 'think-tank-guide', description: '智库用法与三段审议法', body: readFileSync(join(HERE, 'skills', 'think-tank.md'), 'utf8') });
}