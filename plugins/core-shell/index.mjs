import { spawn } from 'node:child_process';

export function setup(ctx) {
  ctx.registerTool({ name: 'shell', description: '在工作区执行 PowerShell 命令体（禁止嵌套 powershell/pwsh -Command）', parameters: { type: 'object', properties: { command: { type: 'string' } }, required: ['command'] } },
    (a) => new Promise((resolve) => {
      const t0 = Date.now();
      const p = spawn('powershell.exe', ['-NoProfile', '-Command', String(a.command)], { cwd: ctx.workspace, windowsHide: true });
      let out = '';
      const timer = setTimeout(() => p.kill(), 60000);
      const onAbort = () => p.kill();
      ctx.kernel.signal?.addEventListener('abort', onAbort, { once: true });
      p.stdout.on('data', (d) => { out += d; });
      p.stderr.on('data', (d) => { out += d; });
      p.on('close', (code) => {
        clearTimeout(timer);
        ctx.kernel.signal?.removeEventListener('abort', onAbort);
        resolve(`exit=${code} wall=${Date.now() - t0}ms\n${out.slice(0, 4000)}${out.length > 4000 ? '\n…(截断)' : ''}`);
      });
    }));
}