import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { describe, expect, it } from 'vitest';
import { lintCommand, typecheckCommand } from '../src/checks/feedback.js';
import { failingTests } from '../src/checks/run-checks.js';
import { main } from '../src/cli.js';
import { createContext } from '../src/context.js';
import { scan } from '../src/scan.js';
import type { Report } from '../src/types.js';
import { runCommand } from '../src/util/run.js';
import { fixture } from './helpers.js';

// Every command here runs in a synthetic temp repo built by the test itself.

function check(report: Report, id: string) {
  const c = report.checks.find((x) => x.id === id);
  if (!c) throw new Error(`no check ${id}`);
  return c;
}

const node = (code: string) => `node -e ${JSON.stringify(code)}`;

function repo(scripts: Record<string, string>, files: Record<string, string> = {}): string {
  return fixture(null, {
    git: true,
    files: {
      'package.json': JSON.stringify({ name: 'run-fixture', scripts }),
      'index.js': 'module.exports = 1;\n',
      ...files,
    },
  });
}

/** A test script that passes on odd runs and fails on even ones, counting runs in a file. */
const ALTERNATING = [
  "const fs = require('node:fs');",
  "const n = fs.existsSync('runs') ? Number(fs.readFileSync('runs', 'utf8')) + 1 : 1;",
  "fs.writeFileSync('runs', String(n));",
  "if (n % 2 === 0) { console.log(' FAIL  test/math.test.js > adds (3 ms)'); process.exit(1); }",
  "console.log('ok');",
].join('\n');

describe('runCommand', () => {
  it('reports exit status, output and missing commands', async () => {
    const ok = await runCommand(node('console.log("hi")'), {
      cwd: process.cwd(),
      timeoutMs: 10_000,
    });
    expect(ok).toMatchObject({ status: 0, timedOut: false, notFound: false });
    expect(ok.output.trim()).toBe('hi');
    const bad = await runCommand(node('process.exit(3)'), {
      cwd: process.cwd(),
      timeoutMs: 10_000,
    });
    expect(bad.status).toBe(3);
    const missing = await runCommand('definitely-not-a-command-xyz', {
      cwd: process.cwd(),
      timeoutMs: 10_000,
    });
    expect(missing.notFound).toBe(true);
  });

  it.skipIf(process.platform === 'win32')('kills the whole process tree on timeout', async () => {
    const dir = fixture(null, {
      files: {
        'spawn.js': [
          "const { spawn } = require('node:child_process');",
          "spawn(process.execPath, ['-e', \"setInterval(() => require('node:fs').writeFileSync('alive', String(Date.now())), 50)\"], { stdio: 'ignore' });",
          'setInterval(() => {}, 1000);',
        ].join('\n'),
      },
    });
    const res = await runCommand('node spawn.js', { cwd: dir, timeoutMs: 500 });
    expect(res.timedOut).toBe(true);
    expect(res.ms).toBeLessThan(5000);
    await sleep(300);
    const alive = join(dir, 'alive');
    expect(existsSync(alive)).toBe(true);
    const t = statSync(alive).mtimeMs;
    await sleep(400);
    expect(statSync(alive).mtimeMs).toBe(t); // the grandchild is gone too
  });
});

describe('--run: lint and typecheck', () => {
  it('are n/a without --run', async () => {
    const r = await scan(repo({ lint: node('process.exit(0)') }));
    for (const id of ['feedback.lint-passes', 'feedback.typecheck-passes', 'feedback.flaky']) {
      expect(check(r, id).score).toBeNull();
    }
  });

  it('score a passing lint and a failing typecheck', async () => {
    const dir = repo({
      test: node('process.exit(0)'),
      lint: node('process.exit(0)'),
      typecheck: node('console.error("src/a.ts(1,1): error TS2322: nope"); process.exit(2)'),
    });
    const r = await scan(dir, { run: true });
    expect(check(r, 'feedback.lint-passes')).toMatchObject({ score: 1 });
    expect(check(r, 'feedback.lint-passes').summary).toMatch(/^`npm run lint` passed in/);
    const tc = check(r, 'feedback.typecheck-passes');
    expect(tc.score).toBe(0.4);
    expect(tc.summary).toMatch(/`npm run typecheck` failed \(exit 2\)/);
    expect(tc.findings?.[0]?.message).toContain('error TS2322');
  });

  it('time out with a low score', async () => {
    const r = await scan(repo({ lint: node('setInterval(() => {}, 1000)') }), {
      run: true,
      runTimeoutMs: 1500,
    });
    expect(check(r, 'feedback.lint-passes')).toMatchObject({ score: 0.2 });
  });

  it('pick commands per ecosystem and never a dangerous script', () => {
    const py = createContext(
      fixture(null, { files: { 'pyproject.toml': '[tool.ruff]\n[tool.mypy]\n', 'uv.lock': '' } }),
    );
    expect(lintCommand(py)).toBe('uv run ruff check .');
    expect(typecheckCommand(py)).toBe('uv run mypy .');
    const go = createContext(
      fixture(null, { files: { 'go.mod': 'module x\n', 'a.go': 'package a\n' } }),
    );
    expect(lintCommand(go)).toBe('go vet ./...');
    expect(typecheckCommand(go)).toBe('go build ./...');
    const risky = createContext(repo({ lint: 'eslint . && npm publish' }));
    expect(lintCommand(risky)).toBeNull();
  });
});

describe('--flaky', () => {
  it('flags a suite that passes once and fails once, running it only twice', async () => {
    const dir = repo({ test: 'node t.js' }, { 't.js': ALTERNATING });
    const r = await scan(dir, { run: true, flaky: true });
    const flaky = check(r, 'feedback.flaky');
    expect(flaky.score).toBe(0);
    expect(flaky.summary).toMatch(
      /Flaky: `npm test` passed on run 1 and failed \(exit 1\) on run 2/,
    );
    expect(flaky.findings?.[0]?.message).toBe('failed in only one run: test/math.test.js > adds');
    // feedback.speed reused the first run
    expect(check(r, 'feedback.speed').summary).toMatch(/passed in/);
    expect(readFileSync(join(dir, 'runs'), 'utf8')).toBe('2');
  });

  it('passes a deterministic suite (green twice or red the same way twice)', async () => {
    const green = await scan(repo({ test: node('process.exit(0)') }), { run: true, flaky: true });
    expect(check(green, 'feedback.flaky').summary).toBe('`npm test` passed twice');
    const red = await scan(
      repo({ test: node('console.log("FAILED tests/test_a.py::test_x"); process.exit(1)') }),
      { run: true, flaky: true },
    );
    expect(check(red, 'feedback.flaky').score).toBe(1);
    expect(check(red, 'feedback.speed').score).toBe(0.3);
  });

  it('is n/a with --run alone', async () => {
    const r = await scan(repo({ test: node('process.exit(0)') }), { run: true });
    expect(check(r, 'feedback.flaky').score).toBeNull();
  });

  it('parses failing test names from common runners', () => {
    const out = [
      ' FAIL  src/a.test.ts > math > adds (12 ms)',
      ' × src/b.test.ts > subtracts 4ms',
      'FAILED tests/test_c.py::test_div - ZeroDivisionError',
      '    --- FAIL: TestParse (0.00s)',
      'test parser::tests::empty ... FAILED',
      'not ok 3 - handles unicode',
    ].join('\n');
    expect([...failingTests(out)]).toEqual([
      'src/a.test.ts > math > adds',
      'src/b.test.ts > subtracts',
      'tests/test_c.py::test_div',
      'TestParse',
      'parser::tests::empty',
      'handles unicode',
    ]);
  });

  it('--flaky implies --run on the CLI and --timeout is validated', async () => {
    const quiet = { stdout: { write: () => true, isTTY: false }, stderr: { write: () => true } };
    let out = '';
    const io = {
      stdout: {
        write: (s: string) => {
          out += s;
          return true;
        },
        isTTY: false,
      },
      stderr: { write: () => true },
    };
    await main([repo({ test: node('process.exit(0)') }), '--flaky', '--json'], io);
    const report = JSON.parse(out) as Report;
    expect(check(report, 'feedback.flaky').score).toBe(1);
    expect(await main(['.', '--timeout', '0'], quiet)).toBe(2);
  });
});
