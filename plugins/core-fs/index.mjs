import { readFileSync, writeFileSync, appendFileSync, existsSync, mkdirSync, readdirSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';

export function setup(ctx) {
  const cpFile = join(ctx.dataDir, 'checkpoints.jsonl');
  const checkpoint = (p) => {
    if (existsSync(p)) appendFileSync(cpFile, JSON.stringify({ ts: Date.now(), path: p, content: readFileSync(p, 'utf8') }) + '\n');
  };
  ctx.registerTool({ name: 'read_file', description: '读文件内容（工作区内自由；工作区外 suggest 模式需批准）', parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] } },
    (a) => readFileSync(resolve(ctx.workspace, a.path), 'utf8').slice(0, 8000));
  ctx.registerTool({ name: 'list_dir', description: '列目录（dir/file 前缀；区外读由闸门策略决定）', parameters: { type: 'object', properties: { path: { type: 'string' } } } },
    (a) => readdirSync(resolve(ctx.workspace, a.path ?? '.'), { withFileTypes: true }).map((d) => `${d.isDirectory() ? 'dir ' : 'file'} ${d.name}`).join('\n'));
  ctx.registerTool({ name: 'write_file', description: '写文件（覆盖前自动快照，可 undo_file 回滚；仅限工作区内）', parameters: { type: 'object', properties: { path: { type: 'string' }, content: { type: 'string' } }, required: ['path', 'content'] } },
    (a) => {
      const p = ctx.kernel.safePath(a.path);
      checkpoint(p);
      mkdirSync(dirname(p), { recursive: true });
      writeFileSync(p, String(a.content ?? ''), 'utf8');
      return `已写入 ${p}`;
    });
  ctx.registerTool({ name: 'undo_file', description: '把文件回滚到最近一次 write_file 覆盖前的快照', parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] } },
    (a) => {
      const p = ctx.kernel.safePath(a.path);
      if (!existsSync(cpFile)) return '无快照可回滚';
      const lines = readFileSync(cpFile, 'utf8').trim().split('\n').filter(Boolean);
      for (let i = lines.length - 1; i >= 0; i--) {
        const e = JSON.parse(lines[i]);
        if (e.path === p) {
          writeFileSync(p, e.content, 'utf8');
          return `已回滚 ${p} 到 ${new Date(e.ts).toLocaleString('zh-CN')} 的快照`;
        }
      }
      return '无快照可回滚';
    });
}