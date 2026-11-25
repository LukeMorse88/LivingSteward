const { app, BrowserWindow, ipcMain, Menu } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const { spawn } = require('node:child_process');

const ROOT = __dirname;
if (process.env.STEWARD_CDP) app.commandLine.appendSwitch('remote-debugging-port', process.env.STEWARD_CDP);
app.setName('Living Steward');
if (app.isPackaged) app.setPath('userData', path.join(path.dirname(process.execPath), 'userdata'));

// 兜底启动命令：仅在缺少 brains/brains.json 时使用，由环境变量指定，未设置则跳过
const QUALITY_CMD = process.env.STEWARD_QUALITY_CMD || '';
const SPEED_CMD = process.env.STEWARD_SPEED_CMD || '';
const BRAINS_DIR = path.join(app.isPackaged ? path.dirname(process.execPath) : ROOT, 'brains');
const BRAINS_CFG = path.join(BRAINS_DIR, 'brains.json');

async function probe(port) {
  try {
    const r = await fetch(`http://127.0.0.1:${port}/v1/models`, { signal: AbortSignal.timeout(1500) });
    return r.ok;
  } catch { return false; }
}
function ensureBrains() {
  if (fs.existsSync(BRAINS_CFG)) {
    for (const b of JSON.parse(fs.readFileSync(BRAINS_CFG, 'utf8')).brains) {
      probe(b.port).then((up) => {
        if (!up) spawn(path.join(BRAINS_DIR, b.exe), b.args, { cwd: BRAINS_DIR, detached: true, stdio: 'ignore', windowsHide: true }).unref();
      });
    }
    return;
  }
  for (const [port, cmd] of [[8080, QUALITY_CMD], [8081, SPEED_CMD]]) {
    probe(port).then((up) => {
      if (!up && fs.existsSync(cmd)) spawn('cmd.exe', ['/c', cmd], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
    });
  }
}

let win;
let steward;

async function createWindow() {
  const { Steward } = await import('./core/kernel.mjs');
  steward = new Steward(ROOT);
  await steward.start();
  win = new BrowserWindow({
    width: 1200,
    height: 820,
    minWidth: 940,
    minHeight: 620,
    title: 'Living Steward · 生活主管',
    backgroundColor: '#faf9f7',
    icon: path.join(ROOT, 'gui', 'icon.png'),
    autoHideMenuBar: true,
    webPreferences: { preload: path.join(ROOT, 'gui', 'preload.cjs'), contextIsolation: true, nodeIntegration: false },
  });
  steward.on('event', (ev) => {
    if (ev.type === 'restart') { app.relaunch(); app.exit(0); return; }
    win?.webContents.send('event', ev);
  });
  ipcMain.handle('get-state', () => steward.state());
  ipcMain.handle('send', (_e, role, text) => steward.send(role, text));
  ipcMain.handle('command', (_e, role, text) => steward.command(role, text));
  ipcMain.handle('ask-answer', (_e, id, answer) => steward.answerAsk(id, answer));
  ipcMain.handle('approval-answer', (_e, id, allow, always) => steward.answerApproval(id, allow, always));
  ipcMain.handle('abort', (_e, role) => steward.abort(role));
  ipcMain.handle('ws-switch', (_e, id) => steward.switchWorkspace(id));
  ipcMain.handle('brains', async () => ({ quality: await probe(8080), speed: await probe(8081) }));
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    { label: 'Living Steward', submenu: [{ role: 'quit', label: '退出' }] },
    { label: '视图', submenu: [{ role: 'reload', label: '重载' }, { role: 'toggleDevTools', label: '开发者工具' }] },
  ]));
  await win.loadFile(path.join(ROOT, 'gui', 'index.html'));
  if (process.env.STEWARD_SHOT) {
    setTimeout(async () => {
      const img = await win.webContents.capturePage();
      fs.writeFileSync(process.env.STEWARD_SHOT, img.toPNG());
    }, Number(process.env.STEWARD_SHOT_DELAY || 4000));
  }
}

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) app.quit();
else {
  app.whenReady().then(() => {
    if (app.isPackaged && !process.env.STEWARD_WORKSPACE && !fs.existsSync(path.join(ROOT, 'workspace.txt'))) {
      process.env.STEWARD_WORKSPACE = path.join(path.dirname(process.execPath), 'workspace');
      fs.mkdirSync(process.env.STEWARD_WORKSPACE, { recursive: true });
    }
    if (app.isPackaged && !process.env.DEEPSEEK_API_KEY) {
      const kf = path.join(path.dirname(process.execPath), 'deepseek.key');
      if (fs.existsSync(kf)) process.env.DEEPSEEK_API_KEY = fs.readFileSync(kf, 'utf8').trim();
    }
    ensureBrains(); createWindow();
  });
  app.on('window-all-closed', () => app.quit());
}