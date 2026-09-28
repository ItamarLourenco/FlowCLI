import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('electronAPI', {
  // Projects
  loadProjects: () => ipcRenderer.invoke('load-projects'),
  saveProjects: (projects: unknown) => ipcRenderer.invoke('save-projects', projects),
  pickDirectory: () => ipcRenderer.invoke('pick-directory'),

  // Terminal
  spawnTerminal: (id: string, cols: number, rows: number, cwd?: string) =>
    ipcRenderer.invoke('spawn-terminal', id, cols, rows, cwd),
  sendInput: (id: string, data: string) => ipcRenderer.invoke('send-input', id, data),
  resizePty: (id: string, cols: number, rows: number) => ipcRenderer.invoke('resize-pty', id, cols, rows),
  killTerminal: (id: string) => ipcRenderer.invoke('kill-terminal', id),

  onOutput: (cb: (p: { id: string; data: string }) => void) =>
    ipcRenderer.on('claude-output', (_e, p) => cb(p)),
  onStatus: (cb: (p: { id: string; status: string }) => void) =>
    ipcRenderer.on('claude-status', (_e, p) => cb(p)),
  onTerminalState: (cb: (p: { id: string; state: string }) => void) =>
    ipcRenderer.on('terminal-state', (_e, p) => cb(p)),
  onLastMessage: (cb: (p: { id: string; message: string }) => void) =>
    ipcRenderer.on('terminal-last-message', (_e, p) => cb(p)),
});
