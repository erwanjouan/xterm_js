import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';

// ----- Command Palette -------------------------------------------------------
type Suggestion =
  | { kind: 'command'; label: string; symbol: string }
  | { kind: 'link';    label: string; symbol: string; url: string };

interface PaletteConfig {
  commands: { label: string; symbol?: string }[];
  links:    { label: string; url: string; symbol?: string }[];
}

async function loadSuggestions(): Promise<Suggestion[]> {
  const res    = await fetch('/api/config');
  const config = await res.json() as PaletteConfig;
  const cmds: Suggestion[]  = (config.commands ?? []).map(c => ({ kind: 'command', label: c.label, symbol: c.symbol ?? '$' }));
  const links: Suggestion[] = (config.links    ?? []).map(l => ({ kind: 'link',    label: l.label, symbol: l.symbol ?? '↗', url: l.url }));
  return [...cmds, ...links];
}

class CommandPalette {
  private backdrop: HTMLElement;
  private input: HTMLInputElement;
  private list: HTMLElement;
  private filtered: Suggestion[] = [];
  private selectedIndex = 0;
  private suggestions: Suggestion[] = [];

  constructor(private ws: WebSocket, private term: Terminal, suggestions: Suggestion[]) {
    this.suggestions = suggestions;
    this.backdrop = document.getElementById('cp-backdrop')!;
    this.input    = document.getElementById('cp-input') as HTMLInputElement;
    this.list     = document.getElementById('cp-list')!;

    // Cmd+X (Mac) or Alt+X (Windows/Linux) — capture phase fires before xterm
    document.addEventListener('keydown', (e) => {
      if ((e.metaKey || e.altKey) && e.key === 'x') {
        e.preventDefault();
        this.open();
      }
    }, true);

    this.backdrop.addEventListener('mousedown', (e) => {
      if (e.target === this.backdrop) this.close();
    });

    this.input.addEventListener('input', () => this.updateFilter());
    this.input.addEventListener('keydown', (e) => this.onKeydown(e));
  }

  private open() {
    this.input.value   = '';
    this.filtered      = [...this.suggestions];
    this.selectedIndex = 0;
    this.render();
    this.backdrop.style.display = 'block';
    this.input.focus();
  }

  private close() {
    this.backdrop.style.display = 'none';
    this.term.focus();
  }

  private updateFilter() {
    const q   = this.input.value.toLowerCase();
    this.filtered = q
      ? this.suggestions.filter(s => s.label.toLowerCase().includes(q))
      : [...this.suggestions];
    this.selectedIndex = 0;
    this.render();
  }

  private render() {
    this.list.innerHTML = '';
    this.filtered.slice(0, 10).forEach((s, i) => {
      const li   = document.createElement('li');
      if (i === this.selectedIndex) li.classList.add('cp-selected');

      const icon = document.createElement('span');
      icon.className   = s.kind === 'link' ? 'cp-icon cp-icon-link' : 'cp-icon cp-icon-cmd';
      icon.textContent = s.symbol;

      const text = document.createElement('span');
      text.textContent = s.label;

      li.append(icon, text);
      li.addEventListener('mousedown', (e) => { e.preventDefault(); this.submit(s); });
      this.list.appendChild(li);
    });
  }

  private onKeydown(e: KeyboardEvent) {
    const max = Math.min(this.filtered.length, 10) - 1;
    switch (e.key) {
      case 'ArrowDown':
        e.preventDefault();
        this.selectedIndex = Math.min(this.selectedIndex + 1, max);
        this.render();
        break;
      case 'ArrowUp':
        e.preventDefault();
        this.selectedIndex = Math.max(this.selectedIndex - 1, 0);
        this.render();
        break;
      case 'Tab': {
        e.preventDefault();
        if (this.filtered.length === 0) break;
        this.selectedIndex = e.shiftKey
          ? Math.max(this.selectedIndex - 1, 0)
          : Math.min(this.selectedIndex + 1, max);
        const sel = this.filtered[this.selectedIndex];
        if (sel) this.input.value = sel.label;
        this.render();
        break;
      }
      case 'Enter': {
        e.preventDefault();
        const s = this.filtered[this.selectedIndex];
        if (s) {
          this.submit(s);
        } else if (this.input.value.trim()) {
          this.submit({ kind: 'command', label: this.input.value.trim() });
        }
        break;
      }
      case 'Escape':
        this.close();
        break;
    }
  }

  private submit(s: Suggestion) {
    if (s.kind === 'link') {
      window.open(s.url, '_blank', 'noopener,noreferrer');
    } else {
      if (this.ws.readyState === WebSocket.OPEN) {
        this.ws.send(JSON.stringify({ type: 'input', data: s.label + '\r' }));
      }
    }
    this.close();
  }
}
// -----------------------------------------------------------------------------

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
loadSuggestions().then(suggestions => new CommandPalette(ws, terminal, suggestions));

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
