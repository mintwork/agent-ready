import { type Language, type RepoContext, runScriptCmd } from '../context.js';
import type { Check, CheckResult, RunOptions } from '../types.js';
import { type RunResult, runCommand } from '../util/run.js';
import { isDangerousScript } from './safety.js';
import { projectTsconfigs } from './type-safety.js';

const JS_TEST_DEPS = [
  'vitest',
  'jest',
  'mocha',
  'ava',
  'tap',
  'uvu',
  '@playwright/test',
  'jasmine',
  'node:test',
];

export function pyHas(ctx: RepoContext, section: string): boolean {
  return ctx.pyproject?.includes(`[${section}`) ?? false;
}

function hasJs(ctx: RepoContext): boolean {
  return ctx.pkg !== null;
}

function hasPy(ctx: RepoContext): boolean {
  return ctx.languages.includes('python');
}

function realTestScript(ctx: RepoContext): string | null {
  const t = ctx.scripts().test;
  if (!t || /no test specified/i.test(t)) return null;
  return t;
}

function pyTestFiles(ctx: RepoContext): string[] {
  return ctx.files.filter((f) => /(^|\/)(test_[^/]*|[^/]*_test)\.py$/.test(f));
}

function pytestConfigured(ctx: RepoContext): boolean {
  return (
    pyHas(ctx, 'tool.pytest') ||
    ctx.has('pytest.ini') ||
    ctx.has('conftest.py') ||
    ctx.files.some((f) => f.endsWith('/conftest.py')) ||
    /\[tool:pytest\]/.test(ctx.read('setup.cfg') ?? '') ||
    /\[pytest\]/.test(ctx.read('tox.ini') ?? '') ||
    ctx.has('tox.ini') ||
    ctx.has('noxfile.py')
  );
}

export function makeTarget(ctx: RepoContext, name: string): boolean {
  const mk = ctx.read('Makefile') ?? ctx.read('justfile') ?? '';
  return new RegExp(`^${name}\\s*:`, 'm').test(mk);
}

/** The command agent-ready would use to run tests, or null if unknown. */
export function testCommand(ctx: RepoContext): string | null {
  if (realTestScript(ctx)) return runScriptCmd(ctx, 'test');
  if (makeTarget(ctx, 'test')) return 'make test';
  if (hasPy(ctx) && (pytestConfigured(ctx) || pyTestFiles(ctx).length)) {
    if (ctx.has('uv.lock')) return 'uv run pytest -q';
    if (ctx.has('poetry.lock')) return 'poetry run pytest -q';
    return 'python3 -m pytest -q';
  }
  if (hasRust(ctx) && ctx.has('Cargo.toml')) return 'cargo test';
  if (hasGo(ctx) && ctx.has('go.mod')) return 'go test ./...';
  return null;
}

/** `uv run ` / `poetry run ` prefix for Python tools, matching the project's environment manager. */
function pyRun(ctx: RepoContext): string {
  if (ctx.has('uv.lock')) return 'uv run ';
  if (ctx.has('poetry.lock')) return 'poetry run ';
  return '';
}

/** The command `--run` uses to lint, or null if none is obvious. Never a dangerous script. */
export function lintCommand(ctx: RepoContext): string | null {
  const lint = ctx.scripts().lint;
  if (lint && !isDangerousScript(lint)) return runScriptCmd(ctx, 'lint');
  if (makeTarget(ctx, 'lint')) return 'make lint';
  if (hasPy(ctx)) {
    if (pyHas(ctx, 'tool.ruff') || ctx.has('ruff.toml') || ctx.has('.ruff.toml'))
      return `${pyRun(ctx)}ruff check .`;
    if (ctx.has('.flake8')) return `${pyRun(ctx)}flake8`;
  }
  if (hasGo(ctx) && ctx.has('go.mod')) {
    return ctx.files.some((f) => /^\.golangci\.(ya?ml|toml|json)$/.test(f))
      ? 'golangci-lint run'
      : 'go vet ./...';
  }
  if (hasRust(ctx) && ctx.has('Cargo.toml')) return 'cargo clippy --quiet --all-targets';
  return null;
}

const TYPECHECK_SCRIPTS = [
  'typecheck',
  'type-check',
  'check-types',
  'types:check',
  'check:types',
  'tsc',
  'types',
];

/** The command `--run` uses to typecheck, or null if none is obvious. */
export function typecheckCommand(ctx: RepoContext): string | null {
  const scripts = ctx.scripts();
  const script = TYPECHECK_SCRIPTS.find((n) => scripts[n] && !isDangerousScript(scripts[n]));
  if (script) return runScriptCmd(ctx, script);
  if (makeTarget(ctx, 'typecheck')) return 'make typecheck';
  if (ctx.languages.includes('typescript') && ctx.exists('node_modules/.bin/tsc')) {
    if (projectTsconfigs(ctx).length > 0) return 'npx --no-install tsc --noEmit';
  }
  if (hasPy(ctx)) {
    if (pyHas(ctx, 'tool.mypy') || ctx.has('mypy.ini')) return `${pyRun(ctx)}mypy .`;
    if (pyHas(ctx, 'tool.pyright') || ctx.has('pyrightconfig.json')) return `${pyRun(ctx)}pyright`;
  }
  if (hasRust(ctx) && ctx.has('Cargo.toml')) return 'cargo check --quiet --all-targets';
  if (hasGo(ctx) && ctx.has('go.mod')) return 'go build ./...';
  return null;
}

const testRuns = new WeakMap<RepoContext, Promise<RunResult>[]>();

/**
 * The n-th run (0-based) of the test command for this context. Runs are shared between checks, so
 * `feedback.speed` and `feedback.flaky` together run the suite twice, not three times.
 */
export function testRun(
  ctx: RepoContext,
  cmd: string,
  opts: RunOptions,
  n = 0,
): Promise<RunResult> {
  const runs = testRuns.get(ctx) ?? [];
  testRuns.set(ctx, runs);
  while (runs.length <= n) {
    const prev = runs[runs.length - 1];
    // Runs are sequential: two suites at once would fight over ports, files and CPU.
    const next = (prev ?? Promise.resolve()).then(() =>
      runCommand(cmd, { cwd: ctx.root, timeoutMs: opts.runTimeoutMs }),
    );
    runs.push(next);
  }
  return runs[n] as Promise<RunResult>;
}

/** Per-language part of a check: its score and how much of the codebase it covers. */
type Part = [score: number, weight: number];

const MIN_PART_WEIGHT = 0.15;

function part(ctx: RepoContext, score: number, ...langs: Language[]): Part {
  return [score, Math.max(MIN_PART_WEIGHT, ctx.share(...langs))];
}

/** Weighted mean of the language parts, so a tooling package.json in a Rust repo counts little. */
function avg(parts: Part[]): number | null {
  const w = parts.reduce((n, [, pw]) => n + pw, 0);
  return parts.length ? parts.reduce((n, [ps, pw]) => n + ps * pw, 0) / w : null;
}

function hasGo(ctx: RepoContext): boolean {
  return ctx.languages.includes('go');
}

function hasRust(ctx: RepoContext): boolean {
  return ctx.languages.includes('rust');
}

/** CI workflow + task runner text, for tools that are configured by being invoked (clippy, golangci-lint). */
function automationText(ctx: RepoContext): string {
  return [
    ...ctx.files.filter(
      (f) => /^\.github\/workflows\/[^/]+\.ya?ml$/.test(f) || f === '.gitlab-ci.yml',
    ),
    'Makefile',
    'justfile',
    '.pre-commit-config.yaml',
  ]
    .map((f) => ctx.read(f) ?? '')
    .join('\n');
}

function rustHasTests(ctx: RepoContext): boolean {
  const rs = ctx.filesWithExt('.rs');
  if (rs.some((f) => /(^|\/)tests\/[^/]+\.rs$|(^|\/)tests?\.rs$|_tests?\.rs$/.test(f))) return true;
  return rs
    .slice(0, 400)
    .some((f) => /#\[(?:test|cfg\(test\)|tokio::test)/.test(ctx.read(f) ?? ''));
}

export const feedbackChecks: Check[] = [
  {
    id: 'feedback.test',
    category: 'feedback',
    title: 'Test command is discoverable',
    weight: 4,
    run(ctx): CheckResult {
      const parts: Part[] = [];
      const notes: string[] = [];
      if (hasJs(ctx)) {
        const deps = ctx.allDeps();
        const framework = JS_TEST_DEPS.find((d) => d in deps);
        const testFiles = ctx.files.filter(
          (f) => /\.(test|spec)\.[cm]?[jt]sx?$/.test(f) || /(^|\/)__tests__\//.test(f),
        );
        if (realTestScript(ctx)) {
          parts.push(part(ctx, 1, 'typescript', 'javascript'));
          notes.push(`\`${runScriptCmd(ctx, 'test')}\``);
        } else if (makeTarget(ctx, 'test')) {
          parts.push(part(ctx, 1, 'typescript', 'javascript'));
          notes.push('`make test`');
        } else if (framework || testFiles.length) {
          parts.push(part(ctx, 0.4, 'typescript', 'javascript'));
          notes.push(`tests exist but no "test" script`);
        } else {
          parts.push(part(ctx, 0, 'typescript', 'javascript'));
          notes.push('no JS tests');
        }
      }
      if (hasPy(ctx)) {
        const files = pyTestFiles(ctx);
        if (files.length && (pytestConfigured(ctx) || makeTarget(ctx, 'test'))) {
          parts.push(part(ctx, 1, 'python'));
          notes.push(`pytest (${files.length} test files)`);
        } else if (files.length) {
          parts.push(part(ctx, 0.75, 'python'));
          notes.push(`${files.length} test files, no pytest config`);
        } else if (pytestConfigured(ctx)) {
          parts.push(part(ctx, 0.5, 'python'));
          notes.push('pytest configured but no test files found');
        } else {
          parts.push(part(ctx, 0, 'python'));
          notes.push('no Python tests');
        }
      }
      if (hasRust(ctx)) {
        const tests = rustHasTests(ctx);
        parts.push(part(ctx, tests ? 1 : 0.3, 'rust'));
        notes.push(tests ? '`cargo test`' : '`cargo test` but no Rust tests found');
      }
      if (hasGo(ctx)) {
        const tests = ctx.files.some((f) => f.endsWith('_test.go'));
        parts.push(part(ctx, tests ? 1 : 0, 'go'));
        notes.push(tests ? '`go test ./...`' : 'no Go tests');
      }
      const score = avg(parts);
      if (score === null) return { score: null, summary: 'No supported language detected' };
      return {
        score,
        summary: `Tests: ${notes.join('; ')}`,
        suggestion:
          score < 1
            ? 'Give agents one obvious command to verify their work: a "test" script in package.json, pytest config in pyproject.toml, or tests `cargo test` / `go test ./...` can find.'
            : undefined,
      };
    },
  },
  {
    id: 'feedback.lint',
    category: 'feedback',
    title: 'Linter configured',
    weight: 2,
    run(ctx): CheckResult {
      const parts: Part[] = [];
      const notes: string[] = [];
      if (hasJs(ctx)) {
        const deps = ctx.allDeps();
        const scripts = ctx.scripts();
        const eslint =
          ctx.files.some((f) => /(^|\/)(eslint\.config\.[cm]?[jt]s|\.eslintrc(\.\w+)?)$/.test(f)) ||
          ctx.pkg?.eslintConfig !== undefined;
        const biome = ctx.has('biome.json') || ctx.has('biome.jsonc');
        const oxlint = ctx.has('.oxlintrc.json') || 'oxlint' in deps;
        const tool = eslint ? 'eslint' : biome ? 'biome' : oxlint ? 'oxlint' : null;
        if (tool) {
          parts.push(part(ctx, scripts.lint ? 1 : 0.8, 'typescript', 'javascript'));
          notes.push(
            scripts.lint ? `${tool} via "lint" script` : `${tool} configured (no "lint" script)`,
          );
        } else if (scripts.lint) {
          parts.push(part(ctx, 0.8, 'typescript', 'javascript'));
          notes.push('"lint" script');
        } else if (ctx.files.some((f) => /(^|\/)\.prettierrc/.test(f)) || 'prettier' in deps) {
          parts.push(part(ctx, 0.3, 'typescript', 'javascript'));
          notes.push('formatter only (prettier)');
        } else {
          parts.push(part(ctx, 0, 'typescript', 'javascript'));
          notes.push('no JS linter');
        }
      }
      if (hasPy(ctx)) {
        const setupCfg = ctx.read('setup.cfg') ?? '';
        const ruff = pyHas(ctx, 'tool.ruff') || ctx.has('ruff.toml') || ctx.has('.ruff.toml');
        const other =
          ctx.has('.flake8') ||
          /\[flake8\]/.test(setupCfg) ||
          ctx.has('.pylintrc') ||
          pyHas(ctx, 'tool.pylint');
        const black = pyHas(ctx, 'tool.black');
        if (ruff || other) {
          parts.push(part(ctx, 1, 'python'));
          notes.push(ruff ? 'ruff' : 'flake8/pylint');
        } else if (black) {
          parts.push(part(ctx, 0.3, 'python'));
          notes.push('formatter only (black)');
        } else {
          parts.push(part(ctx, 0, 'python'));
          notes.push('no Python linter');
        }
      }
      if (hasRust(ctx) || hasGo(ctx)) {
        const auto = automationText(ctx);
        if (hasRust(ctx)) {
          const cargo = ctx.read('Cargo.toml') ?? '';
          const clippy =
            ctx.has('clippy.toml') ||
            ctx.has('.clippy.toml') ||
            /^\[(?:workspace\.)?lints/m.test(cargo) ||
            /\bclippy\b/.test(auto);
          parts.push(part(ctx, clippy ? 1 : 0.7, 'rust'));
          notes.push(clippy ? 'clippy' : 'clippy available but not configured or run in CI');
        }
        if (hasGo(ctx)) {
          const linter =
            ctx.files.some((f) => /^\.golangci\.(ya?ml|toml|json)$/.test(f)) ||
            /\b(golangci-lint|staticcheck)\b/.test(auto);
          parts.push(part(ctx, linter ? 1 : 0.6, 'go'));
          notes.push(
            linter ? 'golangci-lint/staticcheck' : 'only `go vet` (no golangci-lint config)',
          );
        }
      }
      const score = avg(parts);
      if (score === null) return { score: null, summary: 'No supported language detected' };
      return {
        score,
        summary: `Lint: ${notes.join('; ')}`,
        suggestion:
          score < 1
            ? 'Configure a fast linter (eslint/biome for JS, ruff for Python, clippy for Rust, golangci-lint for Go) and run it in CI.'
            : undefined,
      };
    },
  },
  {
    id: 'feedback.typecheck',
    category: 'feedback',
    title: 'Typecheck command available',
    weight: 2,
    run(ctx): CheckResult {
      const parts: Part[] = [];
      const notes: string[] = [];
      if (ctx.languages.includes('typescript')) {
        const scripts = ctx.scripts();
        const typecheckScript = Object.entries(scripts).find(
          ([name, body]) =>
            /^(typecheck|type-check|check-types|types|tsc|check:types|types:check)$/.test(name) ||
            /\b(tsc|vue-tsc|svelte-check|tsgo)\b/.test(body) ||
            // monorepo task runners: `turbo run check-types`, `nx run-many -t typecheck`
            /\b(turbo|nx|lerna|pnpm\s+-r|pnpm\s+--recursive|wireit)\b[^&;|]*\b(typecheck|type-check|check-types|types)\b/.test(
              body,
            ),
        );
        if (typecheckScript) {
          parts.push(part(ctx, 1, 'typescript'));
          notes.push(`"${typecheckScript[0]}" script`);
        } else if (projectTsconfigs(ctx).length > 0) {
          parts.push(part(ctx, 0.6, 'typescript'));
          notes.push('tsconfig.json but no typecheck script');
        } else {
          parts.push(part(ctx, 0.2, 'typescript'));
          notes.push('TypeScript without tsconfig.json');
        }
      }
      if (hasPy(ctx)) {
        const mypy =
          pyHas(ctx, 'tool.mypy') ||
          ctx.has('mypy.ini') ||
          /\[mypy\]/.test(ctx.read('setup.cfg') ?? '');
        const pyright =
          pyHas(ctx, 'tool.pyright') ||
          pyHas(ctx, 'tool.basedpyright') ||
          ctx.has('pyrightconfig.json');
        if (mypy || pyright) {
          parts.push(part(ctx, 1, 'python'));
          notes.push(mypy ? 'mypy' : 'pyright');
        } else {
          parts.push(part(ctx, 0, 'python'));
          notes.push('no mypy/pyright config');
        }
      }
      if (hasRust(ctx)) {
        parts.push(part(ctx, 1, 'rust'));
        notes.push('`cargo check`');
      }
      if (hasGo(ctx)) {
        parts.push(part(ctx, 1, 'go'));
        notes.push('`go build ./...`');
      }
      const score = avg(parts);
      if (score === null) return { score: null, summary: 'No typed language detected' };
      return {
        score,
        summary: `Typecheck: ${notes.join('; ')}`,
        suggestion:
          score < 1
            ? 'Add a `typecheck` script (`tsc --noEmit`) or a mypy/pyright config so agents can catch type errors fast.'
            : undefined,
      };
    },
  },
  {
    id: 'feedback.ci',
    category: 'feedback',
    title: 'CI runs checks',
    weight: 1,
    run(ctx): CheckResult {
      const ci = ctx.files.find(
        (f) =>
          /^\.github\/workflows\/[^/]+\.ya?ml$/.test(f) ||
          f === '.gitlab-ci.yml' ||
          f.startsWith('.circleci/') ||
          f === 'azure-pipelines.yml' ||
          f === 'Jenkinsfile' ||
          f === '.travis.yml' ||
          f === 'bitbucket-pipelines.yml' ||
          f.startsWith('.buildkite/'),
      );
      return ci
        ? { score: 1, summary: `CI config: ${ci}` }
        : {
            score: 0,
            summary: 'No CI config found',
            suggestion:
              'Add CI (e.g. `.github/workflows/ci.yml`) so agents and reviewers share one definition of "green".',
          };
    },
  },
  {
    id: 'feedback.speed',
    category: 'feedback',
    title: 'Tests run fast',
    weight: 2,
    async run(ctx, opts): Promise<CheckResult> {
      if (!opts.run) return { score: null, summary: 'Skipped (pass --run to time the test suite)' };
      const cmd = testCommand(ctx);
      if (!cmd) return { score: 0, summary: 'No test command to run' };
      const res = await testRun(ctx, cmd, opts);
      const secs = res.ms / 1000;
      if (res.timedOut) {
        return {
          score: 0.1,
          summary: `\`${cmd}\` timed out after ${Math.round(secs)}s`,
          suggestion: 'Provide a fast subset (e.g. `test:unit`) agents can run in seconds.',
        };
      }
      if (res.status !== 0) {
        return {
          score: 0.3,
          summary: `\`${cmd}\` failed (exit ${res.status}) in ${secs.toFixed(1)}s`,
          suggestion:
            'A red baseline means agents cannot tell whether they broke something. Fix or quarantine failing tests.',
        };
      }
      const score = secs < 10 ? 1 : secs < 30 ? 0.85 : secs < 60 ? 0.7 : secs < 180 ? 0.4 : 0.2;
      return {
        score,
        summary: `\`${cmd}\` passed in ${secs.toFixed(1)}s`,
        suggestion:
          score < 1
            ? 'Slow suites get skipped. Offer a quick target that runs in under 10s.'
            : undefined,
      };
    },
  },
];
