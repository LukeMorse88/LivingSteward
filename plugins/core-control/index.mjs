export function setup(ctx) {
  ctx.registerCommand({ name: 'help', description: '全部命令 / 技能 / 插件 / 模式', usage: '/help' },
    (rest, c) => {
      const s = c.kernel.state();
      return [
        `审批模式：${s.mode}（suggest 人工审批 / auto-edit 区内写免批 / full-auto 区内全免批 / plan 只读）`,
        `工作区：${s.workspace}`,
        `插件：${s.plugins.join(', ')}`,
        '',
        '命令：',
        ...s.commands.map((x) => `/${x.name} — ${x.description}${x.usage ? `  (${x.usage})` : ''}`),
        '',
        '技能：',
        ...s.skills.map((x) => `/${x.name} — ${x.description}`),
      ].join('\n');
    });
  ctx.registerCommand({ name: 'mode', description: '查看/切换审批模式', usage: '/mode [suggest|auto-edit|full-auto|plan]' },
    (rest, c) => {
      const m = rest.trim();
      if (!m) return `当前：${c.kernel.mode}。可选 suggest / auto-edit / full-auto / plan`;
      c.kernel.setMode(m);
      return `审批模式 → ${m}`;
    });
  ctx.registerCommand({ name: 'plan', description: '进入计划模式（只读，禁止执行）', usage: '/plan' },
    (rest, c) => { c.kernel.setMode('plan'); return '计划模式：只读。/mode full-auto 退出。'; });
  ctx.registerCommand({ name: 'ws', description: '工作区管理', usage: '/ws [list|add 名 路径|use id|rm id|rule 模式 allow|hold|deny]' },
    (rest, c) => {
      const [sub, ...args] = rest.trim().split(/\s+/);
      const s = c.kernel.state();
      if (!sub || sub === 'list') return s.workspaces.map((w) => `${w.id === s.activeWs ? '●' : '○'} ${w.id}  ${w.name}  ${w.path}`).join('\n');
      if (sub === 'add') { c.kernel.addWorkspace(args[0], args.slice(1).join(' ')); return `已添加并切换：${args[0]}`; }
      if (sub === 'use') { c.kernel.switchWorkspace(args[0]); return `已切换：${c.kernel.state().workspace}`; }
      if (sub === 'rm') { c.kernel.removeWorkspace(args[0]); return '已删除工作区。'; }
      if (sub === 'rule') {
        const [pattern, action] = args;
        const rules = s.whitelist.filter((r) => r.pattern !== pattern);
        rules.unshift({ pattern, action, note: '命令行设置' });
        c.kernel.saveWhitelist(rules);
        return `规则 ${pattern} → ${action}`;
      }
      return '用法：/ws list|add 名 路径|use id|rm id|rule tool:xxx allow|hold|deny';
    });
  ctx.registerCommand({ name: 'audit', description: '最近 10 条闸门审计', usage: '/audit' },
    (rest, c) => c.kernel.auditTail().slice(-10).join('\n') || '(空)');
  ctx.registerCommand({ name: 'stop', description: '中止本对话本轮', usage: '/stop' },
    (rest, c, role) => { c.kernel.abort(role); return '已中止。'; });
  ctx.registerCommand({ name: 'restart', description: '重启应用（core 修改后生效）', usage: '/restart' },
    (rest, c) => { c.kernel.restart(); return '重启中…'; });
}