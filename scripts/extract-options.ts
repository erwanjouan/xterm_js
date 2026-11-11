import { loadManOptions, loadGitSubcommands, loadGitSubcmdOptions, loadDockerSubcommands, loadDockerSubcmdOptions, loadKubectlSubcommands, loadKubectlSubcmdOptions } from '../src/man-parser';
import path from 'path';
import fs from 'fs';

const commands = process.argv.slice(2);
if (commands.length === 0) {
  console.error('Usage: extract-options <cmd> [cmd ...]');
  process.exit(1);
}

const platform = process.platform;
const outDir = path.join(__dirname, '..', 'options', platform);
fs.mkdirSync(outDir, { recursive: true });

function write(name: string, data: unknown) {
  const file = path.join(outDir, `${name}.json`);
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
  return path.relative(process.cwd(), file);
}

for (const cmd of commands) {
  if (cmd === 'git') {
    const subcommands = loadGitSubcommands();
    console.log(`git      ${subcommands.length} subcommands  →  ${write('git', subcommands)}`);
    for (const sub of subcommands) {
      const opts = loadGitSubcmdOptions(sub.flags);
      if (opts.length > 0) {
        const rel = write(`git-${sub.flags}`, opts);
        console.log(`  git-${sub.flags.padEnd(18)} ${opts.length} options  →  ${rel}`);
      }
    }
  } else if (cmd === 'kubectl') {
    const subcommands = loadKubectlSubcommands();
    console.log(`kubectl  ${subcommands.length} subcommands  →  ${write('kubectl', subcommands)}`);
    for (const sub of subcommands) {
      const opts = loadKubectlSubcmdOptions(sub.flags);
      if (opts.length > 0) {
        const rel = write(`kubectl-${sub.flags}`, opts);
        console.log(`  kubectl-${sub.flags.padEnd(16)} ${opts.length} options  →  ${rel}`);
      }
    }
  } else if (cmd === 'docker') {
    const subcommands = loadDockerSubcommands();
    console.log(`docker   ${subcommands.length} subcommands  →  ${write('docker', subcommands)}`);

    for (const sub of subcommands) {
      const opts = loadDockerSubcmdOptions(sub.flags);
      if (opts.length > 0) {
        const rel = write(`docker-${sub.flags}`, opts);
        console.log(`  docker-${sub.flags.padEnd(14)} ${opts.length} options  →  ${rel}`);
      }
    }
  } else {
    const opts = loadManOptions(cmd);
    console.log(`${cmd.padEnd(8)} ${opts.length} options  →  ${write(cmd, opts)}`);
  }
}
