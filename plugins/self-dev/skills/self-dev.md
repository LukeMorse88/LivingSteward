# 自我开发契约（everything is a plugin）

应用根 = core/kernel.mjs + core/loop.mjs + core/llm.mjs + main.cjs + gui/ + plugins/。内核只做：注册表、闸门、会话、双 Agent 循环。其余一切皆插件。

## 新建插件
1. `self_write plugins/<名>/plugin.json`：{"name","version","description","main":"index.mjs","scope":"local"|"cloud"}
2. `self_write plugins/<名>/index.mjs`：export function setup(ctx){...}（可 async）
3. `plugin_reload` → 立即生效，无需重启。

## ctx API
- ctx.registerTool({name,description,parameters(JSON Schema)}, handler(args,ctx))
- ctx.registerCommand({name,description,usage}, handler(rest,ctx,role)) → 用户 /name 调用
- ctx.registerSkill({name,description,body}) → 自动获得 /name 注入命令 + 系统提示索引
- ctx.registerHook('pre-tool'|'post-tool'|'session-start'|'prompt-submit', fn(payload,ctx))；pre-tool 返回 {block:true,note} 可否决
- ctx.registerService(name, obj) → 内核/ GUI 服务位（如 mcp）
- ctx.dataDir（data/）、ctx.workspace、ctx.aux（速度小模型 stream）、ctx.emit(ev)
- ctx.kernel：workspace/mode/setMode/state/sessions{list,resume,fork,create}/compact/abort/inject/subagent/supervise{ask,dispatch}/rebuild/restart/safePath/root/signal/auditTail/saveWhitelist/switchWorkspace/addWorkspace/removeWorkspace

## 约束
- scope:'cloud' 的工具只进云视图；云永远只有监督通道（内核强制）。
- 工具名建议 plugin__<插件>__<动作>；内置裸名（shell/read_file…）已被 core 插件占用。
- 改 core/*.mjs 或 main.cjs 后 /restart 生效。禁止防御性编程：错误直接抛给循环回模型。
- 隐私：L3 关键词内核否决；本地细节不上行。