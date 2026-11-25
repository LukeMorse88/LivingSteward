export function setup(ctx) {
  ctx.registerTool({ name: 'ask_user', description: '向用户弹 ASK 卡片提问。仅写操作目标不明时使用。', parameters: { type: 'object', properties: { question: { type: 'string' }, options: { type: 'array', items: { type: 'string' } } }, required: ['question'] } },
    (a) => ctx.kernel.supervise.ask(a.question, a.options));
  ctx.registerTool({ name: 'dispatch', description: '下行通道：把子任务派给本地执行脑（可含完整插件代码供落盘）。你只收状态位。', parameters: { type: 'object', properties: { subtask: { type: 'string', description: '完整子任务描述，含完成标准' } }, required: ['subtask'] } },
    (a) => ctx.kernel.supervise.dispatch(a.subtask));
}