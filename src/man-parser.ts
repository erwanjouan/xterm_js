import { spawnSync } from 'child_process';

export interface CommandOption {
  flags: string;
  description: string;
}

// ----- linux.die.net web scraper (Windows fallback) ---------------------------

function stripHtml(html: string): string {
  return html
    .replace(/<[^>]+>/g, '')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&nbsp;/g, ' ')
    .trim();
}

function fetchOptionsFromSection(cmd: string, section: number): CommandOption[] {
  const result = spawnSync(
    'curl',
    ['-s', '--max-time', '10', `https://linux.die.net/man/${section}/${cmd}`],
    { encoding: 'utf8', timeout: 15000 }
  );
  if (!result.stdout) return [];

  const html = result.stdout;
  const options: CommandOption[] = [];
  const dlRe = /<dl compact>([\s\S]*?)<\/dl>/gi;
  let dlMatch;

  while ((dlMatch = dlRe.exec(html)) !== null) {
    const parts = dlMatch[1].split(/<dt>/i).slice(1);
    for (const part of parts) {
      const ddIdx = part.search(/<dd>/i);
      if (ddIdx === -1) continue;
      const flags = stripHtml(part.slice(0, ddIdx));
      const afterDd = part.slice(ddIdx + 4);
      const description = stripHtml(afterDd.split(/<dt>/i)[0]);
      if (flags) options.push({ flags, description });
    }
  }

  return options;
}

export function loadManOptionsFromWeb(cmd: string): CommandOption[] {
  // Try section 1 (user commands) first; fall back to section 8 (network/admin)
  const opts = fetchOptionsFromSection(cmd, 1);
  if (opts.length > 0) return opts;
  return fetchOptionsFromSection(cmd, 8);
}
// -----------------------------------------------------------------------------

export function extractManOptions(text: string): CommandOption[] {
  const lines = text.split('\n');
  const options: CommandOption[] = [];

  let startIdx = -1;
  for (let i = 0; i < lines.length; i++) {
    if (/options? (?:are available|are as follows)/i.test(lines[i]) || /^\s*OPTIONS\s*$/.test(lines[i])) {
      startIdx = i + 1;
      break;
    }
  }
  if (startIdx < 0) return options;

  let flags = '';
  let descParts: string[] = [];

  const flush = () => {
    if (flags) {
      options.push({ flags, description: descParts.join(' ').trim() });
      flags = '';
      descParts = [];
    }
  };

  // BSD man pages indent flag lines with 4-8 spaces; continuation lines use 13+.
  // Requiring 4-8 spaces prevents continuation text that starts with - from being
  // misread as a new flag declaration.
  const FLAG_LINE = /^ {4,8}-[A-Za-z0-9@%!#+_]/;

  for (let i = startIdx; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();

    if (trimmed && !line.startsWith(' ') && /^[A-Z]/.test(trimmed)) break;
    if (!trimmed) { flush(); continue; }

    if (FLAG_LINE.test(line)) {
      const m = line.match(/^ {4,8}(-\S.*?)(?:\s{2,}(.+))?$/);
      if (m) {
        flush();
        flags = m[1].trim();
        if (m[2]) descParts.push(m[2].trim());
        continue;
      }
    }

    if (flags) descParts.push(trimmed);
  }

  flush();
  return options;
}

export function loadManOptions(cmd: string): CommandOption[] {
  const result = spawnSync(
    'bash',
    ['-c', `man ${cmd} 2>/dev/null | col -bx 2>/dev/null`],
    { encoding: 'utf8', timeout: 10000, env: { ...process.env, TERM: 'dumb', MANPAGER: 'cat' } }
  );
  if (!result.stdout) return [];
  return extractManOptions(result.stdout);
}

// ----- git -------------------------------------------------------------------

export function loadGitSubcommands(): CommandOption[] {
  const result = spawnSync('git', ['--help'], { encoding: 'utf8', timeout: 5000 });
  const output = (result.stdout ?? '') + (result.stderr ?? '');
  const lines = output.split('\n');
  const options: CommandOption[] = [];
  let inSection = false;

  for (const line of lines) {
    const trimmed = line.trim();
    // Section headers: not indented, non-empty, not a footer line
    if (!line.startsWith(' ') && trimmed && !/^('|See |git )/.test(trimmed)) {
      inSection = true;
      continue;
    }
    if (!trimmed) continue;
    if (inSection) {
      // "   name     description" — 3-space indent
      const m = line.match(/^\s{3}([\w-]+)\s{2,}(.+)/);
      if (m) options.push({ flags: m[1], description: m[2].trim() });
    }
  }
  return options;
}

export function loadGitSubcmdOptions(subcmd: string): CommandOption[] {
  // git -h writes to stderr and exits non-zero; capture both streams
  const result = spawnSync('git', [subcmd, '-h'], { encoding: 'utf8', timeout: 5000 });
  const output = (result.stdout ?? '') + (result.stderr ?? '');
  const lines = output.split('\n');
  const options: CommandOption[] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    // Accept 2-space or 4-space indented flag lines (varies by subcommand)
    if (!/^ {2,4}-/.test(line)) continue;

    const m = line.match(/^ {2,4}(-[\w ,<>=\[\]|./*:-]+?)(?:\s{2,}(.+))?$/);
    if (!m) continue;

    const flags = m[1].trim();
    let description = (m[2] ?? '').trim();

    // Wrapped: description on the next line, indented deeper than the flag line
    if (!description && i + 1 < lines.length && /^\s{8}/.test(lines[i + 1])) {
      description = lines[++i].trim();
    }

    options.push({ flags, description });
  }
  return options;
}

// ----- kubectl ---------------------------------------------------------------

export function loadKubectlSubcommands(): CommandOption[] {
  const result = spawnSync('kubectl', ['--help'], { encoding: 'utf8', timeout: 5000 });
  const output = (result.stdout ?? '') + (result.stderr ?? '');
  const lines = output.split('\n');
  const options: CommandOption[] = [];
  let inSection = false;

  for (const line of lines) {
    const trimmed = line.trim();
    // Section headers: non-indented, end with ':', skip stop-words
    if (!line.startsWith(' ') && trimmed.endsWith(':') &&
        !/^(Usage|Options|Examples|Use )/.test(trimmed)) {
      inSection = true;
      continue;
    }
    if (!line.startsWith(' ') && trimmed) { inSection = false; continue; }
    if (inSection) {
      const m = line.match(/^\s{1,4}([\w-]+)\s{2,}(.+)/);
      if (m) options.push({ flags: m[1], description: m[2].trim() });
    }
  }
  return options;
}

export function loadKubectlSubcmdOptions(subcmd: string): CommandOption[] {
  const result = spawnSync('kubectl', [subcmd, '--help'], { encoding: 'utf8', timeout: 5000 });
  const output = (result.stdout ?? '') + (result.stderr ?? '');
  const lines = output.split('\n');
  const options: CommandOption[] = [];
  let inOptions = false;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();

    if (/^Options:/.test(trimmed)) { inOptions = true; continue; }
    if (inOptions && !line.startsWith(' ') && trimmed) { inOptions = false; continue; }
    if (!inOptions) continue;

    // Flag line: "    -X, --flag=default:" (4 spaces, then flag text, colon at end)
    const m = line.match(/^    (-[\w ,=.'[\]!*-]+):\s*$/);
    if (m) {
      const flags = m[1].trim();
      // Description follows on the next tab-indented line(s)
      const descParts: string[] = [];
      while (i + 1 < lines.length && /^\t/.test(lines[i + 1])) {
        descParts.push(lines[++i].trim());
      }
      options.push({ flags, description: descParts.join(' ') });
    }
  }
  return options;
}

// ----- Docker ----------------------------------------------------------------

export function loadDockerSubcommands(): CommandOption[] {
  const result = spawnSync('docker', ['help'], { encoding: 'utf8', timeout: 5000 });
  const output = (result.stdout ?? '') + (result.stderr ?? '');
  const lines = output.split('\n');
  const options: CommandOption[] = [];
  let inSection = false;

  for (const line of lines) {
    const trimmed = line.trim();
    if (/^(Common Commands|Management Commands|Commands):/.test(trimmed)) { inSection = true; continue; }
    if (inSection) {
      if (trimmed && !line.startsWith(' ')) { inSection = false; continue; }
      // "  name*    description" — strip plugin marker *
      const m = line.match(/^\s{1,4}(\w[\w-]*)\*?\s{2,}(.+)/);
      if (m) options.push({ flags: m[1], description: m[2].trim() });
    }
  }
  return options;
}

export function loadDockerSubcmdOptions(subcmd: string): CommandOption[] {
  const result = spawnSync('docker', [subcmd, '--help'], { encoding: 'utf8', timeout: 5000 });
  const output = (result.stdout ?? '') + (result.stderr ?? '');
  const lines = output.split('\n');
  const options: CommandOption[] = [];
  let inOptions = false;

  for (const line of lines) {
    const trimmed = line.trim();
    if (/^Options:/.test(trimmed)) { inOptions = true; continue; }
    if (inOptions) {
      if (trimmed && !line.startsWith(' ')) { inOptions = false; continue; }
      const m = line.match(/^\s{2,8}(-[\w ,=-].*?)(?:\s{3,}(.+))?$/);
      if (m) {
        options.push({ flags: m[1].trim(), description: (m[2] ?? '').trim() });
      } else if (options.length > 0 && trimmed) {
        // continuation line — append to previous option's description
        options[options.length - 1].description += ' ' + trimmed;
      }
    }
  }
  return options;
}
