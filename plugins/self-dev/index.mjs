import { readFileSync, writeFileSync, mkdirSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));

export function setup(ctx) {
  const abs = (p) => join(ctx.kernel.root, String(p ?? '.'));
  ctx.registerTool({ name: 'self_list', description: '列自身源码目录（相对应用根）', parameters: { type: 'object', properties: { path: { type: 'string' } } } },
    (a) => readdirSync(abs(a.path), { withFileTypes: true }).map((d) => `${d.isDirectory() ? 'dir ' : 'file'} ${d.name}`).join('\n'));
  ctx.registerTool({ name: 'self_read', description: '读自身源码（core/plugins/gui/main.cjs 全裸露）', parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] } },
    (a) => readFileSync(abs(a.path), 'utf8'));
  ctx.registerTool({ name: 'self_write', description: '写自身源码（新插件/改 core）。插件写完用 plugin_reload 热生效；core 写完 /restart', parameters: { type: 'object', properties: { path: { type: 'string' }, content: { type: 'string' } }, required: ['path', 'content'] } },
    (a) => {
      const p = abs(a.path);
      mkdirSync(dirname(p), { recursive: true });
      writeFileSync(p, String(a.content), 'utf8');
      return `已写入 ${p}`;
    });
  ctx.registerTool({ name: 'plugin_reload', description: '热重载全部插件（重建注册表，新插件立即生效）', parameters: { type: 'object', properties: {} } },
    async () => {
      await ctx.kernel.rebuild();
      return `热重载完成：${ctx.kernel.state().plugins.join(', ')}`;
    });
  ctx.registerSkill({ name: 'self-dev', description: '插件契约与自我开发流程', body: readFileSync(join(HERE, 'skills', 'self-dev.md'), 'utf8') });
}