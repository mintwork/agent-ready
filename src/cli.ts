import { parseArgs } from 'node:util';
import { createContext } from './context.js';
import { applyFixes, planFixes } from './fix/index.js';
import { renderStrictPlans, strictMigrationPlans } from './fix/strict-plan.js';
import { badgeMarkdown } from './report/badge.js';
import { renderTerminal } from './report/terminal.js';
import { scanContext } from './scan.js';
import { makeColors, shouldUseColor } from './util/color.js';
import { renderDiff } from './util/diff.js';
import { NAME, VERSION } from './version.js';

export interface Io {
  stdout: { write(s: string): unknown; isTTY?: boolean };
  stderr: { write(s: string): unknown };
}

const HELP = `
${NAME} — score how well AI coding agents can work in your repo

Usage
  npx @mintwork/agent-ready [path] [options]

Options
  --json             Machine-readable JSON report
  --badge            Print a shields.io badge (markdown) for your README
  --fix              Apply safe auto-fixes (AGENTS.md/CLAUDE.md, .gitignore, .cursorignore/.ignore,
                     .env.example) and print a TypeScript strict-mode migration plan
  --dry-run          With --fix: show the diff without writing
  --force            With --fix: allow overwriting existing files
  --run              Execute the test command and score its speed
  --min-score <n>    Exit 1 if the score is below n (CI gating)
  --verbose, -v      Show passing checks and all findings
  --no-color         Disable colors
  --version          Print version
  --help, -h         Show this help

Examples
  npx ${NAME}                      # score the current directory
  npx ${NAME} --fix                # generate AGENTS.md + CLAUDE.md, fix .gitignore
  npx ${NAME} --min-score 70       # fail CI below 70
  npx ${NAME} --badge >> README.md
`;

export async function main(argv: string[], io: Io = process): Promise<number> {
  let parsed: ReturnType<typeof parse>;
  try {
    parsed = parse(argv);
  } catch (err) {
    io.stderr.write(`${(err as Error).message}\n${HELP}`);
    return 2;
  }
  const { values, positionals } = parsed;
  if (values.help) {
    io.stdout.write(HELP);
    return 0;
  }
  if (values.version) {
    io.stdout.write(`${VERSION}\n`);
    return 0;
  }
  const colors = makeColors(!values['no-color'] && !values.json && shouldUseColor(io.stdout));
  const root = positionals[0] ?? '.';
  const minScore = values['min-score'] === undefined ? undefined : Number(values['min-score']);
  if (minScore !== undefined && (!Number.isFinite(minScore) || minScore < 0 || minScore > 100)) {
    io.stderr.write('--min-score must be a number between 0 and 100\n');
    return 2;
  }

  let ctx: ReturnType<typeof createContext>;
  try {
    ctx = createContext(root);
  } catch (err) {
    io.stderr.write(`${(err as Error).message}\n`);
    return 2;
  }
  const scanOpts = { run: Boolean(values.run) };
  let report = await scanContext(ctx, scanOpts);

  if (values.fix) {
    const before = report.score;
    // Report-only advice, computed before the fixes change anything.
    const strictPlan = renderStrictPlans(ctx, strictMigrationPlans(ctx));
    const changes = planFixes(ctx);
    const log = values.json ? io.stderr : io.stdout;
    if (changes.length === 0) {
      log.write(
        `\n  Nothing to auto-fix. Remaining items need a human (or an agent) — see the report.\n`,
      );
    } else {
      const res = applyFixes(ctx, changes, {
        force: Boolean(values.force),
        dryRun: Boolean(values['dry-run']),
      });
      for (const ch of res.written) {
        log.write(
          `\n${colors.c('bold', `${values['dry-run'] ? 'Would write' : ch.kind === 'append' ? 'Updated' : 'Created'} ${ch.path}`)} ${colors.c('gray', `— ${ch.description}`)}\n`,
        );
        log.write(`${renderDiff(ch.path, ch.before, ch.after, colors)}\n`);
      }
      for (const s of res.skipped) {
        log.write(`\n${colors.c('yellow', `Skipped ${s.change.path}`)}: ${s.reason}\n`);
      }
      if (!values['dry-run'] && res.written.length) {
        ctx = createContext(root);
        report = await scanContext(ctx, scanOpts);
        log.write(
          `\n  ${colors.c('bold', 'Score')}: ${before} → ${colors.c('green', String(report.score))}\n`,
        );
        const unlock = report.potentialScore - report.score;
        if (unlock > 0) {
          log.write(
            `  ${colors.c('yellow', `Fill in the TODO sections in ${report.templateDocs.join(', ')} to unlock the remaining +${unlock} points.`)}\n`,
          );
          log.write(
            `  ${colors.c('gray', 'Generated docs earn partial credit until a human edits them — the best context is written by people who know the code.')}\n`,
          );
        } else if (res.written.some((w) => w.path.endsWith('.md'))) {
          log.write(
            `  ${colors.c('gray', 'Review the generated docs — the best context is written by people who know the code.')}\n`,
          );
        }
      }
    }
    if (strictPlan.length) {
      const [title, ...rest] = strictPlan;
      log.write(`\n  ${colors.c('bold', title ?? '')}\n${rest.join('\n')}\n`);
    }
  }

  if (values.json) {
    io.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } else if (values.badge) {
    io.stdout.write(`${badgeMarkdown(report.score)}\n`);
  } else {
    io.stdout.write(renderTerminal(report, colors, { verbose: Boolean(values.verbose) }));
  }

  if (minScore !== undefined && report.score < minScore) {
    io.stderr.write(`${NAME}: score ${report.score} is below --min-score ${minScore}\n`);
    return 1;
  }
  return 0;
}

function parse(argv: string[]) {
  return parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      json: { type: 'boolean' },
      badge: { type: 'boolean' },
      fix: { type: 'boolean' },
      'dry-run': { type: 'boolean' },
      force: { type: 'boolean' },
      run: { type: 'boolean' },
      'min-score': { type: 'string' },
      verbose: { type: 'boolean', short: 'v' },
      'no-color': { type: 'boolean' },
      version: { type: 'boolean' },
      help: { type: 'boolean', short: 'h' },
    },
  });
}
