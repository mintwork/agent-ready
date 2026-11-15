import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { main } from '../src/cli.js';
import { createContext } from '../src/context.js';
import { dotenvKeys, envExampleFix } from '../src/fix/env-example.js';
import { applyFixes, planFixes } from '../src/fix/index.js';
import { strictMigrationPlans } from '../src/fix/strict-plan.js';
import { scan } from '../src/scan.js';
import { fixture } from './helpers.js';

function capture() {
  let out = '';
  return {
    io: {
      stdout: {
        write: (s: string) => {
          out += s;
          return true;
        },
        isTTY: false,
      },
      stderr: { write: () => true },
    },
    out: () => out,
  };
}

/** A value that must never be copied into generated files. Built from pieces. */
const REAL_VALUE = ['s3cr3t', 'Vq8Lm2Zr7Wp4'].join('-');

describe('--fix: .env.example from env var usage', () => {
  const app = (extra: Record<string, string> = {}) =>
    fixture(null, {
      git: true,
      files: {
        'package.json': JSON.stringify({ name: 'app', dependencies: { dotenv: '^16.0.0' } }),
        'src/db.ts': [
          "import 'dotenv/config';",
          'export const url = process.env.DATABASE_URL;',
          "export const key = process.env['STRIPE_KEY'] ?? '';",
          'export const env = process.env.NODE_ENV;',
          'export const home = process.env.HOME;',
        ].join('\n'),
        'src/web.ts': 'export const port = Number(process.env.PORT ?? 3000);\n',
        'test/db.test.ts': 'process.env.TEST_ONLY_VAR = "1";\n',
        'scripts/release.ts': 'console.log(process.env.RELEASE_TOKEN);\n',
        ...extra,
      },
    });

  it('lists the names the product code reads, grouped by file, with empty values', () => {
    const [change] = envExampleFix(createContext(app()));
    expect(change?.path).toBe('.env.example');
    expect(change?.kind).toBe('create');
    const text = change?.after ?? '';
    expect(text).toContain('# src/db.ts\nDATABASE_URL=\nSTRIPE_KEY=\n');
    expect(text).toContain('# src/web.ts\nPORT=\n');
    // system/tooling vars, tests and release scripts are not project configuration
    for (const n of ['NODE_ENV', 'HOME', 'TEST_ONLY_VAR', 'RELEASE_TOKEN']) {
      expect(text).not.toContain(n);
    }
  });

  it('adds keys from a local .env but never its values', () => {
    const dir = app({
      '.env': `DATABASE_URL=postgres://u:${REAL_VALUE}@db\nSESSION_SECRET=${REAL_VALUE}\n`,
    });
    const ctx = createContext(dir);
    const changes = planFixes(ctx);
    const env = changes.find((c) => c.path === '.env.example');
    expect(env?.after).toContain('SESSION_SECRET=\n');
    expect(env?.after).not.toContain(REAL_VALUE);
    applyFixes(ctx, env ? [env] : [], { force: false, dryRun: false });
    const written = readFileSync(join(dir, '.env.example'), 'utf8');
    expect(written).not.toContain(REAL_VALUE);
    expect(written).toMatch(/^DATABASE_URL=$/m);
  });

  it('reads Python, Go and Rust env access', () => {
    const dir = fixture(null, {
      files: {
        '.env': 'X=1\n',
        'app/settings.py': "import os\nA = os.getenv('API_BASE')\nB = os.environ['REDIS_URL']\n",
        'cmd/main.go': 'package main\nimport "os"\nvar t = os.Getenv("GO_TOKEN")\n',
        'src/main.rs': 'fn main() { let _ = std::env::var("RUST_LOG_LEVEL"); }\n',
      },
    });
    const text = envExampleFix(createContext(dir))[0]?.after ?? '';
    for (const n of ['API_BASE', 'REDIS_URL', 'GO_TOKEN', 'RUST_LOG_LEVEL', 'X']) {
      expect(text).toMatch(new RegExp(`^${n}=$`, 'm'));
    }
  });

  it('does nothing when a template exists or nothing loads .env files', () => {
    expect(envExampleFix(createContext(app({ '.env.sample': 'A=\n' })))).toEqual([]);
    const noDotenv = fixture(null, {
      files: {
        'package.json': '{"name":"cli"}',
        'src/cli.ts': 'export const t = process.env.GITHUB_TOKEN_X;\n',
      },
    });
    expect(envExampleFix(createContext(noDotenv))).toEqual([]);
  });

  it('parses dotenv keys only', () => {
    expect(dotenvKeys(`# c\nexport A=1\nB = "${REAL_VALUE}"\nnot a line\n`)).toEqual(['A', 'B']);
  });
});

describe('--fix: hide generated code from agents', () => {
  const minified = `${'var a=1;'.repeat(8000)}\n`;

  it('writes .cursorignore and .ignore entries and the check passes afterwards', async () => {
    const dir = fixture('good-ts', {
      git: true,
      files: {
        'public/app.min.js': minified,
        'src/generated/api.ts': `// @generated\n${'export const x = 1;\n'.repeat(4000)}`,
        'src/generated/types.ts': `${'export type T = string;\n'.repeat(3000)}`,
        '.ignore': 'tmp/\n',
      },
    });
    const before = await scan(dir);
    expect(before.checks.find((c) => c.id === 'nav.generated')?.fixable).toBe(true);
    const ctx = createContext(dir);
    const changes = planFixes(ctx).filter(
      (c) => c.path === '.cursorignore' || c.path === '.ignore',
    );
    expect(changes.map((c) => [c.path, c.kind])).toEqual([
      ['.cursorignore', 'create'],
      ['.ignore', 'append'],
    ]);
    expect(changes[0]?.after).toContain('/public/app.min.js\n');
    expect(changes[0]?.after).toContain('/src/generated/\n');
    expect(changes[1]?.after.startsWith('tmp/\n')).toBe(true);
    applyFixes(ctx, changes, { force: false, dryRun: false });
    const after = await scan(dir);
    expect(after.checks.find((c) => c.id === 'nav.generated')?.score).toBe(1);
    // nothing left to add on a second run
    expect(planFixes(createContext(dir)).some((c) => c.path === '.cursorignore')).toBe(false);
  });
});

describe('--fix: TypeScript strict migration plan', () => {
  const loose = () =>
    fixture('good-ts', {
      git: true,
      files: {
        'tsconfig.json': JSON.stringify({
          compilerOptions: { strict: false, noImplicitAny: true, alwaysStrict: true },
        }),
        'src/err.ts': 'try { f(); } catch (e) { console.log(e); }\n',
      },
    });

  it('orders the remaining strict flags and skips those already on', () => {
    const [plan] = strictMigrationPlans(createContext(loose()));
    expect(plan?.tsconfig).toBe('tsconfig.json');
    const todo = plan?.steps.filter((s) => !s.done).map((s) => s.flag);
    expect(todo).toEqual([
      'strictBindCallApply',
      'strictFunctionTypes',
      'noImplicitThis',
      'useUnknownInCatchVariables',
      'strictNullChecks',
      'strictPropertyInitialization',
    ]);
    expect(strictMigrationPlans(createContext(fixture('good-ts', { git: true })))).toEqual([]);
  });

  it('is printed by --fix but never edits the tsconfig', async () => {
    const dir = loose();
    const tsconfig = readFileSync(join(dir, 'tsconfig.json'), 'utf8');
    const t = capture();
    await main([dir, '--fix'], t.io);
    expect(t.out()).toContain('TypeScript strict-mode migration plan');
    expect(t.out()).toContain('2 of 8 strict flags already on');
    expect(t.out()).toContain('npx tsc --noEmit -p tsconfig.json --strictBindCallApply');
    expect(t.out()).toMatch(/~1 catch clause/);
    expect(readFileSync(join(dir, 'tsconfig.json'), 'utf8')).toBe(tsconfig);
  });
});
