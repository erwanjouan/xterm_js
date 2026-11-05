import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';

const terminal = new Terminal({
  cursorBlink: true,
  fontFamily: 'Menlo, Monaco, "Courier New", monospace',
  fontSize: 14,
  theme: {
    background: '#1e1e1e',
    foreground: '#d4d4d4',
  },
});

const fitAddon = new FitAddon();
terminal.loadAddon(fitAddon);

terminal.open(document.getElementById('terminal')!);
fitAddon.fit();

const ws = new WebSocket(`ws://${window.location.host}`);

ws.addEventListener('open', () => {
  terminal.focus();
  const { cols, rows } = terminal;
  ws.send(JSON.stringify({ type: 'resize', cols, rows }));
});

ws.addEventListener('message', (event) => {
  const msg = JSON.parse(event.data as string);
  if (msg.type === 'output') {
    terminal.write(msg.data as string);
  }
});

ws.addEventListener('close', () => {
  terminal.write('\r\n\x1b[31mConnection closed.\x1b[0m\r\n');
});

terminal.onData((data) => {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type: 'input', data }));
  }
});

terminal.onResize(({ cols, rows }) => {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type: 'resize', cols, rows }));
  }
});

window.addEventListener('resize', () => {
  fitAddon.fit();
});
