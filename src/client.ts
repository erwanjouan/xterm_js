import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';

// ----- Command Palette -------------------------------------------------------
type Suggestion =
  | { kind: 'command'; label: string; symbol: string }
  | { kind: 'link';    label: string; symbol: string; url: string };

interface LauncherConfig {
  commands: { label: string; symbol?: string }[];
  links:    { label: string; url: string; symbol?: string }[];
}

interface PaletteConfig {
  launcher: LauncherConfig;
}

async function loadSuggestions(): Promise<Suggestion[]> {
  const res      = await fetch('/api/config');
  const config   = await res.json() as PaletteConfig;
  const launcher = config.launcher ?? { commands: [], links: [] };
  const cmds: Suggestion[]  = launcher.commands.map(c => ({ kind: 'command', label: c.label, symbol: c.symbol ?? '$' }));
  const links: Suggestion[] = launcher.links.map(l => ({ kind: 'link',    label: l.label, symbol: l.symbol ?? '↗', url: l.url }));
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
        this.ws.send(JSON.stringify({ type: 'command', name: s.label }));
      }
    }
    this.close();
  }
}
// ----- Options overlay -------------------------------------------------------
interface CommandOption { flags: string; description: string; }

class InputTracker {
  private line = '';
  private cursor = 0;

  feed(data: string): string {
    if (data.startsWith('\x1b')) {
      if (data === '\x1b[C') this.cursor = Math.min(this.cursor + 1, this.line.length);
      else if (data === '\x1b[D') this.cursor = Math.max(this.cursor - 1, 0);
      else if (data === '\x1b[H') this.cursor = 0;
      else if (data === '\x1b[F') this.cursor = this.line.length;
      else if (data === '\x1b[3~') {
        this.line = this.line.slice(0, this.cursor) + this.line.slice(this.cursor + 1);
      }
      return this.line;
    }
    for (const ch of data) {
      const code = ch.charCodeAt(0);
      if (ch === '\r' || ch === '\x03') {
        this.line = '';
        this.cursor = 0;
      } else if (ch === '\x7f') {
        if (this.cursor > 0) {
          this.line = this.line.slice(0, this.cursor - 1) + this.line.slice(this.cursor);
          this.cursor--;
        }
      } else if (code >= 32) {
        this.line = this.line.slice(0, this.cursor) + ch + this.line.slice(this.cursor);
        this.cursor++;
      }
    }
    return this.line;
  }

  reset() { this.line = ''; this.cursor = 0; }
}

function parseInput(line: string): { cmd: string | null; filterText: string } {
  // After a pipe, analyse only the last pipeline segment
  const pipeIdx = line.lastIndexOf('|');
  const raw = (pipeIdx === -1 ? line : line.slice(pipeIdx + 1)).trimStart();
  if (!raw) return { cmd: null, filterText: '' };

  const tokens = raw.split(/\s+/);
  const first = tokens[0] ?? '';
  if (!first) return { cmd: null, filterText: '' };

  const trailingSpace = raw.endsWith(' ');
  const second = tokens[1] ?? '';

  // "cmd word [...]" where word is not a flag → subcommand pattern
  if (second && !second.startsWith('-')) {
    // subcommand is locked in once there's a trailing space or further tokens
    if (trailingSpace || tokens.length > 2) {
      const compoundKey = `${first}-${second}`;
      const last = tokens[tokens.length - 1] ?? '';
      return { cmd: compoundKey, filterText: !trailingSpace && last.startsWith('-') ? last : '' };
    }
    // still completing the subcommand name: show parent options filtered by prefix
    return { cmd: first, filterText: second };
  }

  // Single command + optional flags
  const last = tokens[tokens.length - 1] ?? '';
  const hasArgs = tokens.length > 1 || trailingSpace;
  return { cmd: first, filterText: hasArgs && last.startsWith('-') ? last : '' };
}

function optionMatchesFlag(opt: CommandOption, filterText: string): boolean {
  if (!filterText || filterText === '-') return true;
  if (filterText.startsWith('-')) {
    if (filterText.startsWith('--')) return opt.flags.includes(filterText);
    return filterText.slice(1).split('').some(c =>
      new RegExp(`(?:^|[ ,])-${c}(?:$|[ ,=\\[])`).test(opt.flags)
    );
  }
  // Subcommand prefix match
  return opt.flags.toLowerCase().startsWith(filterText.toLowerCase());
}

class OptionsOverlay {
  private panel: HTMLElement;
  private titleEl: HTMLElement;
  private listEl: HTMLElement;
  private cache = new Map<string, CommandOption[]>();
  private generation = 0;

  constructor() {
    this.panel   = document.getElementById('opt-panel')!;
    this.titleEl = document.getElementById('opt-title')!;
    this.listEl  = document.getElementById('opt-list')!;
    // Prevent clicks on the panel from stealing focus away from the terminal.
    // Wheel events are unaffected so the list stays scrollable.
    this.panel.addEventListener('mousedown', e => e.preventDefault());
  }

  async update(cmd: string | null, flagText: string) {
    if (!cmd) { this.hide(); return; }

    const gen = ++this.generation;

    if (!this.cache.has(cmd)) {
      const res = await fetch(`/api/options/${cmd}`);
      if (gen !== this.generation) return;
      this.cache.set(cmd, await res.json() as CommandOption[]);
    }

    if (gen !== this.generation) return;
    const opts = this.cache.get(cmd)!;
    if (!opts.length) { this.hide(); return; }

    this.titleEl.textContent = cmd;
    this.renderList(opts, flagText);
    this.panel.style.display = 'flex';
  }

  hide() { this.panel.style.display = 'none'; this.generation++; }

  private renderList(opts: CommandOption[], flagText: string) {
    this.listEl.innerHTML = '';

    // When a flag is typed, show only matching options (with full description).
    // Otherwise show all options in compact single-line form.
    const matches = flagText ? opts.filter(o => optionMatchesFlag(o, flagText)) : [];
    const toShow  = matches.length > 0 ? matches : opts;
    const matched = matches.length > 0;

    toShow.forEach(opt => {
      const row = document.createElement('div');
      row.className = 'opt-row' + (matched ? ' opt-row-match' : '');

      const flagSpan = document.createElement('span');
      flagSpan.className   = 'opt-flag';
      flagSpan.textContent = opt.flags;

      const descSpan = document.createElement('span');
      descSpan.className   = 'opt-desc';
      descSpan.textContent = opt.description;

      row.append(flagSpan, descSpan);
      this.listEl.appendChild(row);
    });

    // Scroll first entry into view when switching to filtered mode
    if (matched) {
      (this.listEl.firstElementChild as HTMLElement | null)?.scrollIntoView({ block: 'nearest' });
    }
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

const inputTracker = new InputTracker();
const optionsOverlay = new OptionsOverlay();

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
  const line = inputTracker.feed(data);
  const { cmd, filterText } = parseInput(line);
  optionsOverlay.update(cmd, filterText);
});

terminal.onResize(({ cols, rows }) => {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type: 'resize', cols, rows }));
  }
});

window.addEventListener('resize', () => {
  fitAddon.fit();
});
