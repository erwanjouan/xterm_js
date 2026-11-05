"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = __importDefault(require("express"));
const http_1 = require("http");
const ws_1 = require("ws");
const pty = __importStar(require("node-pty"));
const path_1 = __importDefault(require("path"));
const fs_1 = __importDefault(require("fs"));
const js_yaml_1 = __importDefault(require("js-yaml"));
const app = (0, express_1.default)();
const server = (0, http_1.createServer)(app);
const wss = new ws_1.WebSocketServer({ server });
app.use(express_1.default.static(path_1.default.join(__dirname, '../public')));
app.get('/api/config', (_req, res) => {
    const configPath = path_1.default.join(__dirname, '../config.yaml');
    const config = js_yaml_1.default.load(fs_1.default.readFileSync(configPath, 'utf8'));
    res.json(config);
});
function resolveShell() {
    if (process.platform !== 'win32') {
        return {
            shell: process.env.SHELL ?? 'bash',
            args: [],
            env: process.env,
        };
    }
    // Git Bash candidate paths in order of preference
    const gitBashCandidates = [
        'C:\\Program Files\\Git\\bin\\bash.exe',
        'C:\\Program Files (x86)\\Git\\bin\\bash.exe',
        process.env['ProgramFiles'] ? path_1.default.join(process.env['ProgramFiles'], 'Git', 'bin', 'bash.exe') : '',
        process.env['ProgramFiles(x86)'] ? path_1.default.join(process.env['ProgramFiles(x86)'], 'Git', 'bin', 'bash.exe') : '',
    ].filter(Boolean);
    const gitBash = gitBashCandidates.find(p => fs_1.default.existsSync(p));
    if (gitBash) {
        // Add Git's unix tools to PATH so bash can find coreutils, ssh, etc.
        const gitRoot = path_1.default.dirname(path_1.default.dirname(gitBash)); // ..\Git
        const gitUsrBin = path_1.default.join(gitRoot, 'usr', 'bin');
        const gitBin = path_1.default.join(gitRoot, 'bin');
        const currentPath = process.env['PATH'] ?? '';
        const env = {
            ...process.env,
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
        env: process.env,
    };
}
const { shell, args, env: shellEnv } = resolveShell();
wss.on('connection', (ws) => {
    const cwd = process.env['HOME'] ?? process.env['USERPROFILE'] ?? (process.platform === 'win32' ? 'C:\\' : '/');
    const ptyProcess = pty.spawn(shell, args, {
        name: 'xterm-256color',
        cols: 80,
        rows: 24,
        cwd,
        env: shellEnv,
    });
    ptyProcess.onData((data) => {
        if (ws.readyState === ws_1.WebSocket.OPEN) {
            ws.send(JSON.stringify({ type: 'output', data }));
        }
    });
    ptyProcess.onExit(() => {
        if (ws.readyState === ws_1.WebSocket.OPEN) {
            ws.close();
        }
    });
    ws.on('message', (raw) => {
        try {
            const msg = JSON.parse(raw.toString());
            if (msg.type === 'input') {
                ptyProcess.write(msg.data);
            }
            else if (msg.type === 'resize') {
                ptyProcess.resize(msg.cols, msg.rows);
            }
        }
        catch {
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
