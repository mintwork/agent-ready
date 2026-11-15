import type { RepoContext } from '../context.js';
import type { Check, CheckResult, RunOptions } from '../types.js';
import { type RunResult, runCommand } from '../util/run.js';
import { lintCommand, testCommand, testRun, typecheckCommand } from './feedback.js';

/**
 * Checks that execute project commands. All of them are n/a unless `--run` (and, for flaky-test
 * detection, `--flaky`) is passed, so a normal scan never runs project code.
 */

function last(output: string, lines = 3): string {
  return (
    output
      .trim()
      .split('\n')
      .map((l) => l.trim())
      // Package-manager chatter (`npm notice run lint`, `> pkg@1.0.0 lint`) is not the tool's output.
      .filter(
        (l) => l && !/^(?:npm (?:notice|error|ERR!|warn)\b|> |\$ |yarn run v|Done in )/.test(l),
      )
      .slice(-lines)
      .join(' | ')
      .slice(0, 200)
  );
}

/** Score a lint/typecheck run: green is 1, red 0.4 (agents can't tell their errors from the baseline). */
function commandResult(kind: string, cmd: string, res: RunResult, timeoutMs: number): CheckResult {
  const secs = (res.ms / 1000).toFixed(1);
  if (res.notFound) {
    return { score: null, summary: `\`${cmd}\` not found (tool not installed?)` };
  }
  if (res.timedOut) {
    return {
      score: 0.2,
      summary: `\`${cmd}\` timed out after ${Math.round(timeoutMs / 1000)}s`,
      suggestion: `Agents run ${kind} after every change; keep it to seconds (cache, scope it to changed files).`,
    };
  }
  if (res.status !== 0) {
    return {
      score: 0.4,
      summary: `\`${cmd}\` failed (exit ${res.status}) in ${secs}s`,
      findings: res.output.trim()
        ? [{ severity: 'warn', message: `last output: ${last(res.output)}` }]
        : [],
      suggestion: `Get ${kind} green on a clean checkout: with a red baseline, agents can't tell which errors they introduced.`,
    };
  }
  return { score: 1, summary: `\`${cmd}\` passed in ${secs}s` };
}

function runner(
  kind: string,
  pick: (ctx: RepoContext) => string | null,
): (ctx: RepoContext, opts: RunOptions) => Promise<CheckResult> {
  return async (ctx, opts) => {
    if (!opts.run) return { score: null, summary: `Skipped (pass --run to run ${kind})` };
    const cmd = pick(ctx);
    if (!cmd) return { score: null, summary: `No ${kind} command to run` };
    const res = await runCommand(cmd, { cwd: ctx.root, timeoutMs: opts.runTimeoutMs });
    return commandResult(kind, cmd, res, opts.runTimeoutMs);
  };
}

/** Lines that name a failing test, normalized (no durations), for vitest/jest, pytest, go, cargo, TAP. */
export function failingTests(output: string): Set<string> {
  const out = new Set<string>();
  const patterns = [
    /^[ \t]*(?:FAIL|✗|×|✕)[ \t]+(\S.*)$/gm,
    /^FAILED[ \t]+(\S+)/gm,
    /^[ \t]*--- FAIL: (\S+)/gm,
    /^test (\S+) \.\.\. FAILED$/gm,
    /^not ok \d+ - (.+)$/gm,
  ];
  for (const re of patterns) {
    for (const m of output.matchAll(re)) {
      const name = (m[1] ?? '')
        .trim()
        .replace(/ ?\(\d+(?:\.\d+)? ?m?s\)$/, '')
        .replace(/ \d+(?:\.\d+)? ?m?s$/, '');
      if (name) out.add(name);
    }
  }
  return out;
}

function describe(res: RunResult): string {
  return res.status === 0 ? 'passed' : `failed (exit ${res.status})`;
}

export const runChecks: Check[] = [
  {
    id: 'feedback.lint-passes',
    category: 'feedback',
    title: 'Lint passes',
    weight: 1,
    run: runner('lint', lintCommand),
  },
  {
    id: 'feedback.typecheck-passes',
    category: 'feedback',
    title: 'Typecheck passes',
    weight: 1,
    run: runner('typecheck', typecheckCommand),
  },
  {
    id: 'feedback.flaky',
    category: 'feedback',
    title: 'Tests are deterministic (run twice)',
    weight: 1,
    async run(ctx, opts): Promise<CheckResult> {
      if (!opts.run || !opts.flaky) {
        return { score: null, summary: 'Skipped (pass --flaky to run the tests twice)' };
      }
      const cmd = testCommand(ctx);
      if (!cmd) return { score: null, summary: 'No test command to run' };
      const a = await testRun(ctx, cmd, opts, 0);
      const b = await testRun(ctx, cmd, opts, 1);
      if (a.timedOut || b.timedOut || a.notFound) {
        return { score: null, summary: `\`${cmd}\` did not finish twice; nothing to compare` };
      }
      const flakySuggestion =
        'Flaky tests teach agents to ignore red. Fix the nondeterminism (time, randomness, ordering, shared state) or quarantine the test.';
      if ((a.status === 0) !== (b.status === 0)) {
        const changed = [...failingTests(a.output), ...failingTests(b.output)];
        return {
          score: 0,
          summary: `Flaky: \`${cmd}\` ${describe(a)} on run 1 and ${describe(b)} on run 2`,
          findings: [...new Set(changed)]
            .slice(0, 10)
            .map((t) => ({ severity: 'warn', message: `failed in only one run: ${t}` })),
          suggestion: flakySuggestion,
        };
      }
      if (a.status !== 0) {
        const fa = failingTests(a.output);
        const fb = failingTests(b.output);
        const diff = [...fa].filter((t) => !fb.has(t)).concat([...fb].filter((t) => !fa.has(t)));
        if (diff.length) {
          return {
            score: 0.5,
            summary: `Flaky: different tests failed on each run (${diff.length} differ)`,
            findings: diff
              .slice(0, 10)
              .map((t) => ({ severity: 'warn', message: `failed in only one run: ${t}` })),
            suggestion: flakySuggestion,
          };
        }
        return {
          score: 1,
          summary: `\`${cmd}\` failed the same way twice (deterministic; see feedback.speed)`,
        };
      }
      return { score: 1, summary: `\`${cmd}\` passed twice` };
    },
  },
];
