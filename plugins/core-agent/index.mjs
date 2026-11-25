export function setup(ctx) {
  ctx.registerTool({ name: 'task', description: '派子Agent在独立上下文完成调查/执行子任务，只把结论摘要带回。子Agent工具仍过闸门。', parameters: { type: 'object', properties: { task: { type: 'string', description: '子任务描述，含完成标准' } }, required: ['task'] } },
    (a) => ctx.kernel.subagent(String(a.task)));
  ctx.registerCommand({ name: 'review', description: '派子Agent审查指定对象，输出结论与风险', usage: '/review <对象或路径>' },
    (rest) => ctx.kernel.subagent(`审查以下对象，输出结论摘要与风险清单：${rest}`));
}