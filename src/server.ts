import express from 'express';
import { createServer } from 'http';
import { WebSocketServer, WebSocket } from 'ws';
import * as pty from 'node-pty';
import path from 'path';
import fs from 'fs';
import yaml from 'js-yaml';
import { CommandOption } from './man-parser';

interface CommandConfig {
  label: string;
  symbol?: string;
  steps?: string[];
}

interface LauncherConfig {
  commands: CommandConfig[];
  links: { label: string; url: string; symbol?: string }[];
}

interface AppConfig {
  autocomplete: string[];
  launcher: LauncherConfig;
}

const configPath = path.join(__dirname, '../config.yaml');
const config = yaml.load(fs.readFileSync(configPath, 'utf8')) as AppConfig;

const app = express();
const server = createServer(app);
const wss = new WebSocketServer({ server });

// ----- Man-page options -------------------------------------------------------
const optionsCache = new Map<string, CommandOption[]>();

const optionsDir = path.join(__dirname, '../options', process.platform);
if (fs.existsSync(optionsDir)) {
  for (const file of fs.readdirSync(optionsDir).filter(f => f.endsWith('.json'))) {
    const key = file.slice(0, -5);
    try {
      optionsCache.set(key, JSON.parse(fs.readFileSync(path.join(optionsDir, file), 'utf8')) as CommandOption[]);
    } catch {
      console.warn(`[options] Failed to parse ${file}`);
    }
  }
  console.log(`Options loaded for: ${[...optionsCache.keys()].sort().join(', ')}`);
} else {
  console.warn(`[options] ${optionsDir} not found — run 'make options' to generate.`);
}
// -----------------------------------------------------------------------------

app.use(express.static(path.join(__dirname, '../public')));

app.get('/api/config', (_req, res) => {
  res.json(config);
});

app.get('/api/options/:cmd', (req, res) => {
  res.json(optionsCache.get(req.params.cmd) ?? []);
});

function resolveShell(): { shell: string; args: string[]; env: Record<string, string> } {
  if (process.platform !== 'win32') {
    return {
      shell: process.env.SHELL ?? 'bash',
      args: [],
      env: process.env as Record<string, string>,
    };
  }

  // Git Bash candidate paths in order of preference
  const gitBashCandidates = [
    'C:\\Program Files\\Git\\bin\\bash.exe',
    'C:\\Program Files (x86)\\Git\\bin\\bash.exe',
    process.env['ProgramFiles'] ? path.join(process.env['ProgramFiles'], 'Git', 'bin', 'bash.exe') : '',
    process.env['ProgramFiles(x86)'] ? path.join(process.env['ProgramFiles(x86)'] as string, 'Git', 'bin', 'bash.exe') : '',
  ].filter(Boolean);

  const gitBash = gitBashCandidates.find(p => fs.existsSync(p));

  if (gitBash) {
    // Add Git's unix tools to PATH so bash can find coreutils, ssh, etc.
    const gitRoot = path.dirname(path.dirname(gitBash)); // ..\Git
    const gitUsrBin = path.join(gitRoot, 'usr', 'bin');
    const gitBin = path.join(gitRoot, 'bin');
    const currentPath = process.env['PATH'] ?? '';
    const env: Record<string, string> = {
      ...(process.env as Record<string, string>),
      PATH: [gitUsrBin, gitBin, currentPath].join(';'),
      TERM: 'xterm-256color',
      // Git Bash uses USERPROFILE as HOME when HOME is not set
      HOME: process.env['HOME'] ?? process.env['USERPROFILE'] ?? 'C:\\',
    };
    return { shell: gitBash, args: ['--login', '-i'], env };
  }

  // Fallback to PowerShell if Git Bash is not found
  console.warn('Git Bash not found, falling back to PowerShell.');
  return {
    shell: 'powershell.exe',
    args: [],
    env: process.env as Record<string, string>,
  };
}

function writeToTty(ptyProcess: pty.IPty, data: string) {
  ptyProcess.write(data);
}

const { shell, args, env: shellEnv } = resolveShell();

wss.on('connection', (ws: WebSocket) => {
  const cwd = process.env['HOME'] ?? process.env['USERPROFILE'] ?? (process.platform === 'win32' ? 'C:\\' : '/');

  const ptyProcess = pty.spawn(shell, args, {
    name: 'xterm-256color',
    cols: 80,
    rows: 24,
    cwd,
    env: shellEnv,
  });

  ptyProcess.onData((data) => {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'output', data }));
    }
  });

  ptyProcess.onExit(() => {
    if (ws.readyState === WebSocket.OPEN) {
      ws.close();
    }
  });

  ws.on('message', async (raw: Buffer) => {
    try {
      const msg = JSON.parse(raw.toString());
      if (msg.type === 'input') {
        writeToTty(ptyProcess, msg.data);
      } else if (msg.type === 'command') {
        const command = config.launcher.commands.find(c => c.label === msg.name);
        if (!command) return;
        const steps = command.steps ?? [command.label];
        // On Windows, ConPTY silently discards the first write after Alt+X opens
        // the palette. A harmless `echo` absorbs that slot so the real steps land.
        const allSteps = process.platform === 'win32' ? ['echo', ...steps] : steps;
        for (const step of allSteps) {
          writeToTty(ptyProcess, step + '\r');
          await new Promise(resolve => setTimeout(resolve, 100));
        }
      } else if (msg.type === 'resize') {
        ptyProcess.resize(msg.cols, msg.rows);
      }
    } catch {
      // ignore malformed messages
    }
  });

  ws.on('close', () => {
    ptyProcess.kill();
  });
});

const PORT = process.env.PORT ?? 3000;
server.listen(PORT, () => {
  console.log(`Terminal server running at http://localhost:${PORT}`);
});
