const fmt = (s) => `${s.id}  ${s.title}  ${new Date(s.created).toLocaleString('zh-CN')}`;

export function setup(ctx) {
  ctx.registerCommand({ name: 'compact', description: '立即压缩本轮历史（辅助小模型摘要）', usage: '/compact' },
    async (rest, c, role) => (await c.kernel.compact(role)) ? '已压缩。' : '无需压缩（低于阈值）。');
  ctx.registerCommand({ name: 'new', description: '开新会话（旧会话可 /resume 恢复）', usage: '/new' },
    (rest, c, role) => { c.kernel.sessions.create(role); return '已开新会话。'; });
  ctx.registerCommand({ name: 'fork', description: '从当前会话分叉一份副本', usage: '/fork' },
    (rest, c, role) => `已分叉会话 ${c.kernel.sessions.fork(role)}。`);
  ctx.registerCommand({ name: 'resume', description: '恢复历史会话', usage: '/resume [会话id]' },
    (rest, c, role) => {
      const id = rest.trim();
      if (!id) return c.kernel.sessions.list(role).map(fmt).join('\n') || '(无历史会话)';
      c.kernel.sessions.resume(role, id);
      return `已恢复会话 ${id}。`;
    });
  ctx.registerCommand({ name: 'sessions', description: '列出全部会话', usage: '/sessions' },
    (rest, c, role) => c.kernel.sessions.list(role).map(fmt).join('\n') || '(无历史会话)');
}