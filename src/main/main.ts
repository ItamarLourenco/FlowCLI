import { app, BrowserWindow, ipcMain, dialog } from 'electron';
import * as path from 'path';
import * as fs from 'fs';
import * as pty from 'node-pty';

// ─── PTY / Terminal ────────────────────────────────────────────────────────────

type TerminalState = 'running' | 'thinking' | 'finish';

interface ClaudeInstance {
  id: string;
  pty: pty.IPty;
  status: 'running' | 'done' | 'error';
  lastState: TerminalState;
}

const instances = new Map<string, ClaudeInstance>();

function sendState(id: string, state: TerminalState) {
  const inst = instances.get(id);
  if (!inst || inst.lastState === state) return;
  inst.lastState = state;
  mainWindow?.webContents.send('terminal-state', { id, state });
}

function spawnPty(id: string, cols = 100, rows = 30, cwd?: string) {
  const shell = process.env.SHELL ?? (process.platform === 'win32' ? 'cmd.exe' : 'zsh');
  const proc = pty.spawn(shell, [], {
    name: 'xterm-256color',
    cols,
    rows,
    cwd: cwd ?? process.env.HOME ?? process.cwd(),
    // Inject task ID so Claude hooks can write state files per task
    env: { ...process.env, FLOWCLI_TASK_ID: id } as Record<string, string>,
  });

  proc.onData((data) => {
    mainWindow?.webContents.send('claude-output', { id, data });
  });

  proc.onExit(({ exitCode }) => {
    const inst = instances.get(id);
    if (inst) inst.status = exitCode === 0 ? 'done' : 'error';
    mainWindow?.webContents.send('claude-status', { id, status: exitCode === 0 ? 'done' : 'error' });
  });

  return proc;
}

ipcMain.handle('spawn-terminal', (_event, id: string, cols: number, rows: number, cwd?: string) => {
  const proc = spawnPty(id, cols, rows, cwd);
  instances.set(id, { id, pty: proc, status: 'running', lastState: 'running' });
  return { id };
});

ipcMain.handle('send-input', (_event, id: string, data: string) => {
  instances.get(id)?.pty.write(data);
});

ipcMain.handle('resize-pty', (_event, id: string, cols: number, rows: number) => {
  instances.get(id)?.pty.resize(cols, rows);
});

ipcMain.handle('kill-terminal', (_event, id: string) => {
  const inst = instances.get(id);
  if (inst) {
    inst.pty.kill();
    instances.delete(id);
    // Clean up state file
    try { fs.unlinkSync(`/tmp/flowcli-${id}.state`); } catch {}
  }
});

// ─── State polling via ~/.claude hooks ───────────────────────────────────────
// Claude hooks (UserPromptSubmit / Stop) write "busy" / "idle" to
// /tmp/flowcli-<FLOWCLI_TASK_ID>.state.  We poll those files every 300ms.

function pollStates() {
  for (const [taskId, inst] of instances) {
    const stateFile = `/tmp/flowcli-${taskId}.state`;
    try {
      if (!fs.existsSync(stateFile)) continue;
      const status = fs.readFileSync(stateFile, 'utf-8').trim();
      if (status === 'busy') {
        sendState(taskId, 'thinking');
      } else if (status === 'idle' && inst.lastState === 'thinking') {
        sendState(taskId, 'finish');
        try {
          const msg = fs.readFileSync(`/tmp/flowcli-${taskId}.lastmsg`, 'utf-8').trim();
          if (msg) mainWindow?.webContents.send('terminal-last-message', { id: taskId, message: msg });
        } catch {}
      }
    } catch {}
  }
}

setInterval(pollStates, 300);

// ─── Projects / Persistence ───────────────────────────────────────────────────

const STATE_FILE = path.join(app.getPath('userData'), 'flowcli-projects.json');

ipcMain.handle('load-projects', () => {
  try {
    if (fs.existsSync(STATE_FILE)) return JSON.parse(fs.readFileSync(STATE_FILE, 'utf-8'));
  } catch {}
  return [];
});

ipcMain.handle('save-projects', (_event, projects: unknown) => {
  fs.writeFileSync(STATE_FILE, JSON.stringify(projects, null, 2));
});

ipcMain.handle('pick-directory', async () => {
  const result = await dialog.showOpenDialog(mainWindow!, {
    properties: ['openDirectory'],
    title: 'Select Project Directory',
  });
  return result.canceled ? null : result.filePaths[0];
});

// ─── Window ───────────────────────────────────────────────────────────────────

let mainWindow: BrowserWindow | null = null;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 860,
    minWidth: 900,
    minHeight: 600,
    backgroundColor: '#0f0f0f',
    titleBarStyle: 'hiddenInset',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  mainWindow.loadFile(path.join(__dirname, '../renderer/index.html'));
  mainWindow.maximize();
}

app.whenReady().then(createWindow);
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
