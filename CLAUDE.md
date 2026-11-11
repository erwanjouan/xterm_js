# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
make options        # extract man-page/help options for all commands in config.yaml → options/<platform>/*.json
make build          # compile server (tsc) + bundle client (esbuild)
make run            # build then start the server at http://localhost:3000
make clean          # rm -rf dist

npm run build:server   # tsc only
npm run build:client   # esbuild src/client.ts → public/client.js
npm run dev            # ts-node server + esbuild --watch (hot client rebuild)
```

`make options` must be run before first launch (or after adding a new command to `config.yaml`) — the server reads pre-generated JSON files and warns if they are missing.

## Architecture

The app is a browser-based terminal with two bolt-on features: a command launcher palette and a live options overlay. There are no tests and no linter configured.

### Runtime flow

```
browser  ──WebSocket──▶  server.ts (node-pty)  ──▶  shell process
         ◀── output ───
```

`server.ts` spawns a PTY shell on WebSocket connect and relays raw terminal data both ways. A second REST endpoint (`GET /api/options/:cmd`) serves pre-generated option JSON files.

### Key source files

| File | Role |
|---|---|
| `src/server.ts` | Express + ws server, PTY management, config loading, options cache |
| `src/client.ts` | xterm.js setup, `InputTracker`, `OptionsOverlay`, `CommandPalette` |
| `src/man-parser.ts` | Extraction helpers for man pages, git, docker, kubectl |
| `scripts/extract-options.ts` | CLI script run by `make options` — writes `options/<platform>/*.json` |
| `public/index.html` | All HTML + inline CSS for both overlays |
| `config.yaml` | Single source of truth for autocomplete commands and launcher entries |

### config.yaml structure

```yaml
autocomplete:        # commands whose options are extracted by make options
  - ls
  - docker          # triggers subcommand expansion (docker-build.json etc.)
  - git             # same
  - kubectl         # same

launcher:
  commands:         # entries shown in the Cmd+X palette; each runs shell steps
  links:            # entries that open a URL in a new tab
```

### Options overlay data flow

1. `make options` runs `scripts/extract-options.ts` which calls the appropriate parser in `man-parser.ts` and writes `options/<platform>/<cmd>.json` (e.g. `options/darwin/ls.json`, `options/darwin/docker-build.json`).
2. At startup `server.ts` scans the whole `options/<platform>/` directory and loads every JSON file into an in-memory map.
3. `GET /api/options/:cmd` returns the array for that key, or `[]`.
4. In the browser `InputTracker` rebuilds the current input line on every keystroke. `parseInput()` derives a lookup key and a filter text:
   - simple command → key = `ls`, filter = `-l`
   - subcommand still being typed → key = `docker`, filter = `bui` (prefix match)
   - subcommand complete → key = `docker-build`, filter = `-t`
5. `OptionsOverlay` fetches (once, then caches) the key's options and renders the panel. When a filter is active only matching rows are shown with their full description; otherwise all rows are shown with truncated descriptions.

### Adding support for a new tool

**Simple command** (man-page based): add its name to `autocomplete` in `config.yaml`, run `make options`.

**Subcommand-style tool**: add a dedicated loader pair (`loadXxxSubcommands` / `loadXxxSubcmdOptions`) in `src/man-parser.ts` following the docker/git/kubectl pattern, add a branch for it in `scripts/extract-options.ts`, then add the name to `config.yaml`.

Each tool's help output has a different format; the parsers in `man-parser.ts` are hand-tuned per tool. Key differences:
- **BSD man pages** (`ls`, `cp`, `rm`…): `man cmd | col -bx`, flag lines indented 4–8 spaces, section trigger "options are available / as follows"
- **docker**: `docker help` / `docker <sub> --help`, flags 2–8 spaces, single-line descriptions with continuation appended
- **kubectl**: `kubectl --help` / `kubectl <sub> --help`, flags indented 4 spaces ending with `:`, descriptions on the next tab-indented line
- **git**: `git --help` (stdout) / `git <sub> -h` (stderr), flags indented 2 or 4 spaces, description same line or on next line at 8+ spaces
