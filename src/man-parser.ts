import { spawnSync } from 'child_process';
import fs from 'fs';
import path from 'path';

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

// ----- Maven -----------------------------------------------------------------

function loadMavenLifecyclePhases(): CommandOption[] {
  const result = spawnSync(
    'curl',
    ['-s', '--max-time', '10', 'https://maven.apache.org/guides/introduction/introduction-to-the-lifecycle.html'],
    { encoding: 'utf8', timeout: 15000 }
  );
  if (!result.stdout) return [];

  const options: CommandOption[] = [];
  const seen = new Set<string>();
  // Only match rows where the second cell is plain text (not <code>-wrapped plugin bindings)
  const rowRe = /<td><code>([a-z][a-z0-9-]*)<\/code><\/td>\s*<td>(?!<code>)([^<]+)<\/td>/gi;
  let match;

  while ((match = rowRe.exec(result.stdout)) !== null) {
    const phase = match[1].trim();
    const description = match[2].trim();
    if (phase && description && !seen.has(phase)) {
      seen.add(phase);
      options.push({ flags: phase, description });
    }
  }

  return options;
}

export function loadMavenOptions(): CommandOption[] {
  const result = spawnSync(
    'curl',
    ['-s', '--max-time', '10', 'https://maven.apache.org/ref/3.6.1/maven-embedder/cli.html'],
    { encoding: 'utf8', timeout: 15000 }
  );
  if (!result.stdout) return [];

  const flags: CommandOption[] = [];
  // Rows alternate classes 'a'/'b'; header row uses <th> so the <td> guard skips it
  const rowRe = /<tr class='[ab]'><td><code>([\s\S]*?)<\/code><\/td><td>([\s\S]*?)<\/td><\/tr>/gi;
  let match;

  while ((match = rowRe.exec(result.stdout)) !== null) {
    const f = stripHtml(match[1]).replace(/,--/g, ', --').trim();
    const description = stripHtml(match[2]).trim();
    if (f) flags.push({ flags: f, description });
  }

  // Lifecycle phases first (most commonly typed), then CLI flags
  return [...loadMavenLifecyclePhases(), ...flags];
}

// ----- npm -------------------------------------------------------------------

// Parse "Configuration" section of `npm help <sub> | col -bx` into configName → description
function parseNpmHelpDescriptions(subcmd: string): Map<string, string> {
  const result = spawnSync(
    'bash', ['-c', `npm help ${subcmd} 2>/dev/null | col -bx 2>/dev/null`],
    { encoding: 'utf8', timeout: 10000, env: { ...process.env, MANPAGER: 'cat', TERM: 'dumb' } }
  );
  const descMap = new Map<string, string>();
  if (!result.stdout) return descMap;

  let inConfig = false;
  let currentParam = '';
  let seenBullets = false;
  let pendingDesc = '';

  const flush = () => {
    if (currentParam && pendingDesc) descMap.set(currentParam, pendingDesc);
    currentParam = ''; seenBullets = false; pendingDesc = '';
  };

  for (const line of result.stdout.split('\n')) {
    const trimmed = line.trim();
    if (/^   Configuration\s*$/.test(line)) { inConfig = true; continue; }
    if (inConfig && /^   [A-Z]/.test(line)) { flush(); break; }
    if (!inConfig) continue;

    // Option name: 3-space indent + lowercase identifier only
    if (/^   [a-z][a-z0-9-]*\s*$/.test(line)) {
      flush();
      currentParam = trimmed;
      continue;
    }
    if (!currentParam || !trimmed) continue;
    if (trimmed.startsWith('•')) { seenBullets = true; continue; }
    // Description lines sit at 7-space indent; bullet continuations are at 11+ spaces
    const indent = line.search(/\S/);
    if (seenBullets && !pendingDesc && indent === 7) pendingDesc = trimmed;
  }
  flush();
  return descMap;
}

// Parse a single bracket group "[flag1|flag2|...]" into a flags string
function parseBracketGroup(bracket: string): string | null {
  // Strip outer [] then remove value placeholders like <hoisted|nested|...>
  const inner = bracket.slice(1, -1).replace(/<[^>]*>/g, '').trim();
  const shortFlags: string[] = [];
  const longFlags: string[] = [];

  for (const part of inner.split('|').map(p => p.trim()).filter(Boolean)) {
    if (!part.startsWith('-')) continue;
    const flag = part.split(/\s/)[0]; // drop trailing value hint
    if (flag.startsWith('--')) longFlags.push(flag);
    else shortFlags.push(flag);
  }

  if (shortFlags.length === 0 && longFlags.length === 0) return null;
  return [...shortFlags, ...longFlags].join(', ');
}

export function loadNpmSubcommands(): CommandOption[] {
  // `npm -l` lists every command with a one-line description: "    name   Description text"
  const result = spawnSync('npm', ['-l'], { encoding: 'utf8', timeout: 5000 });
  const output = (result.stdout ?? '') + (result.stderr ?? '');
  const options: CommandOption[] = [];
  let inCommands = false;

  for (const line of output.split('\n')) {
    if (/^All commands:/.test(line)) { inCommands = true; continue; }
    if (!inCommands) continue;
    // Command lines: 4-space indent + name + 2+ spaces + description
    const m = line.match(/^    ([a-z][a-z0-9-]*)  {2,}(.+)/);
    if (m) options.push({ flags: m[1], description: m[2].trim() });
  }
  return options;
}

export function loadNpmSubcmdOptions(subcmd: string): CommandOption[] {
  const hResult = spawnSync('npm', [subcmd, '-h'], { encoding: 'utf8', timeout: 5000 });
  const hOutput = (hResult.stdout ?? '') + (hResult.stderr ?? '');
  const descMap = parseNpmHelpDescriptions(subcmd);

  const options: CommandOption[] = [];
  const seen = new Set<string>();
  let inOptions = false;

  for (const line of hOutput.split('\n')) {
    if (/^Options:/.test(line)) { inOptions = true; continue; }
    if (inOptions && /^aliases:/.test(line.trim())) break;
    if (!inOptions || !line.trim()) continue;

    // Match non-nested bracket groups only
    const bracketRe = /\[([^\[\]]*)\]/g;
    let m;
    while ((m = bracketRe.exec(line)) !== null) {
      const flags = parseBracketGroup(m[0]);
      if (!flags || seen.has(flags)) continue;
      seen.add(flags);

      // Look up description via the first non-negated long flag
      const primary = flags.split(', ').find(f => f.startsWith('--') && !f.startsWith('--no-'));
      const description = primary ? (descMap.get(primary.slice(2)) ?? '') : '';
      options.push({ flags, description });
    }
  }
  return options;
}

// ----- Angular CLI -----------------------------------------------------------

function camelToKebab(s: string): string {
  return s.replace(/([A-Z])/g, m => '-' + m.toLowerCase());
}

function findNgSchematicsPath(): string | null {
  const result = spawnSync('npm', ['root', '-g'], { encoding: 'utf8', timeout: 5000 });
  const globalRoot = result.stdout?.trim();
  if (globalRoot) {
    const p = path.join(globalRoot, '@angular', 'cli', 'node_modules', '@schematics', 'angular');
    if (fs.existsSync(p)) return p;
  }
  const local = path.join(process.cwd(), 'node_modules', '@schematics', 'angular');
  if (fs.existsSync(local)) return local;
  return null;
}

export function loadNgSubcommands(): CommandOption[] {
  const result = spawnSync('ng', ['--help'], { encoding: 'utf8', timeout: 5000 });
  const output = (result.stdout ?? '') + (result.stderr ?? '');
  const options: CommandOption[] = [];
  let inCommands = false;

  for (const line of output.split('\n')) {
    if (/^Commands:/.test(line)) { inCommands = true; continue; }
    if (inCommands && /^Options:/.test(line)) break;
    if (!inCommands) continue;

    const usageMatch = line.match(/^\s+ng\s+([a-z][a-z0-9-]*)/);
    if (!usageMatch) continue;
    const name = usageMatch[1];

    const descIdx = line.search(/\s{2,}[A-Z]/);
    if (descIdx === -1) { options.push({ flags: name, description: '' }); continue; }

    const description = line.slice(descIdx).trim().replace(/\s{2,}\[aliases:.*$/, '').trim();
    options.push({ flags: name, description });
  }
  return options;
}

export function loadNgCommandOptions(cmd: string): CommandOption[] {
  const result = spawnSync('ng', [cmd, '--help'], { encoding: 'utf8', timeout: 5000 });
  const output = (result.stdout ?? '') + (result.stderr ?? '');
  if (!output.includes('Options:')) return [];

  const options: CommandOption[] = [];
  let inOptions = false;

  for (const line of output.split('\n')) {
    if (/^Options:/.test(line.trim())) { inOptions = true; continue; }
    if (!inOptions || !line.trim()) continue;

    const m = line.match(/^\s{2,6}(-[a-zA-Z],\s+)?(--[a-z][a-z0-9-]*)\s{2,}(.*)/);
    if (!m) continue;

    const shortFlag = m[1] ? m[1].trim().replace(/,$/, '') : '';
    const longFlag = m[2];
    const description = m[3].trim().replace(/\s{2,}\[.*$/, '').trim();
    const flags = shortFlag ? `${shortFlag}, ${longFlag}` : longFlag;
    options.push({ flags, description });
  }
  return options;
}

export function loadNgGenerateSchematics(): CommandOption[] {
  const schematicsPath = findNgSchematicsPath();
  if (!schematicsPath) return [];

  const collectionPath = path.join(schematicsPath, 'collection.json');
  if (!fs.existsSync(collectionPath)) return [];

  const collection = JSON.parse(fs.readFileSync(collectionPath, 'utf8')) as {
    schematics: Record<string, { description?: string; hidden?: boolean; aliases?: string[] }>;
  };
  return Object.entries(collection.schematics)
    .filter(([, s]) => !s.hidden)
    .map(([name, s]) => ({ flags: name, description: s.description ?? '' }));
}

export function loadNgGenerateSchematicOptions(schematic: string): CommandOption[] {
  const schematicsPath = findNgSchematicsPath();
  if (!schematicsPath) return [];

  const schemaPath = path.join(schematicsPath, schematic, 'schema.json');
  if (!fs.existsSync(schemaPath)) return [];

  const schema = JSON.parse(fs.readFileSync(schemaPath, 'utf8')) as {
    properties?: Record<string, { description?: string; alias?: string; 'x-deprecated'?: string; visible?: boolean }>;
  };
  const options: CommandOption[] = [];

  for (const [name, prop] of Object.entries(schema.properties ?? {})) {
    if (prop['x-deprecated'] || prop.visible === false) continue;
    const longFlag = '--' + camelToKebab(name);
    const flags = prop.alias ? `-${prop.alias}, ${longFlag}` : longFlag;
    options.push({ flags, description: (prop.description ?? '').trim() });
  }
  return options;
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
