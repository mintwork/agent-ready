import { describe, expect, it } from 'vitest';
import { main } from '../src/cli.js';
import { createContext, createPackageContext } from '../src/context.js';
import { scan } from '../src/scan.js';
import type { Report } from '../src/types.js';
import {
  detectWorkspaces,
  goWorkUses,
  tomlArray,
  workspaceGlobRe,
  yamlList,
} from '../src/workspaces.js';
import { bigFile, fixture } from './helpers.js';

function check(report: Report, id: string) {
  const c = report.checks.find((x) => x.id === id);
  if (!c) throw new Error(`no check ${id}`);
  return c;
}

/** `n` small TypeScript modules under `dir/src`. */
function tsFiles(dir: string, n: number): Record<string, string> {
  return Object.fromEntries(
    Array.from({ length: n }, (_, i) => [`${dir}/src/m${i}.ts`, `export const v${i} = ${i};\n`]),
  );
}

const ROOT_DOC = [
  '# AGENTS.md',
  '',
  '## Commands',
  '',
  '```bash',
  'npm run build',
  'npm test',
  'npm run lint',
  '```',
  '',
  '## Architecture',
  '',
  '- `packages/` — workspace packages',
  '',
].join('\n');

function jsMonorepo(extra: Record<string, string> = {}): string {
  return fixture(null, {
    git: true,
    files: {
      'package.json': JSON.stringify({
        name: 'mono',
        private: true,
        workspaces: ['packages/*', '!packages/legacy'],
        scripts: { test: 'vitest run', lint: 'biome check .', build: 'tsc -b' },
        devDependencies: { vitest: '^5.0.0', typescript: '^5.0.0' },
      }),
      'biome.json': '{}',
      '.gitignore': 'node_modules/\ndist/\n',
      'tsconfig.base.json': '{ "compilerOptions": { "strict": true } }',
      'AGENTS.md': ROOT_DOC,
      'CLAUDE.md': '@AGENTS.md\n',
      'packages/core/package.json': JSON.stringify({ name: '@mono/core' }),
      'packages/core/tsconfig.json': '{ "extends": "../../tsconfig.base.json" }',
      ...tsFiles('packages/core', 12),
      'packages/core/test/core.test.ts': 'export {};\n',
      'packages/web/package.json': JSON.stringify({ name: '@mono/web' }),
      'packages/web/tsconfig.json': '{ "compilerOptions": {} }',
      ...tsFiles('packages/web', 12),
      'packages/web/src/huge.ts': bigFile(1500),
      'packages/legacy/package.json': JSON.stringify({ name: '@mono/legacy' }),
      ...tsFiles('packages/legacy', 3),
      'examples/demo/package.json': JSON.stringify({ name: 'demo' }),
      ...extra,
    },
  });
}

describe('workspace manifest parsing', () => {
  it('matches workspace globs against directories', () => {
    expect(workspaceGlobRe('packages/*').test('packages/core')).toBe(true);
    expect(workspaceGlobRe('packages/*').test('packages/core/sub')).toBe(false);
    expect(workspaceGlobRe('./apps/**').test('apps/a/b')).toBe(true);
    expect(workspaceGlobRe('crates/cli/').test('crates/cli')).toBe(true);
  });

  it('reads pnpm-workspace.yaml package lists', () => {
    const yaml = [
      'packages:',
      "  - 'packages/*'",
      '  - "apps/*" # deployables',
      "  - '!**/test/**'",
      'catalog:',
      '  - react',
    ].join('\n');
    expect(yamlList(yaml, 'packages')).toEqual(['packages/*', 'apps/*', '!**/test/**']);
    expect(yamlList('packages: [a/*, "b"]\n', 'packages')).toEqual(['a/*', 'b']);
  });

  it('reads multi-line Cargo workspace members', () => {
    const toml = [
      '[package]',
      'name = "root"',
      'members = ["not-this"]',
      '',
      '[workspace]',
      'members = [',
      '  "crates/*", # all crates',
      '  "tools/xtask",',
      ']',
      'exclude = ["crates/old"]',
    ].join('\n');
    expect(tomlArray(toml, 'workspace', 'members')).toEqual(['crates/*', 'tools/xtask']);
    expect(tomlArray(toml, 'workspace', 'exclude')).toEqual(['crates/old']);
    expect(tomlArray('[package]\nname = "x"\n', 'workspace', 'members')).toBeNull();
  });

  it('reads go.work use directives', () => {
    expect(
      goWorkUses('go 1.22\n\nuse (\n\t./api\n\t./cmd/tool // the CLI\n)\nuse ./sdk\n'),
    ).toEqual(['api', 'cmd/tool', 'sdk']);
  });
});

describe('detectWorkspaces', () => {
  it('is null for a single-package repo', () => {
    expect(detectWorkspaces(createContext(fixture('good-ts', { git: true })))).toBeNull();
  });

  it('finds npm workspaces, honoring negations and skipping examples', () => {
    const ws = detectWorkspaces(createContext(jsMonorepo()));
    expect(ws?.kinds).toEqual(['npm']);
    expect(ws?.packages.map((p) => [p.dir, p.name])).toEqual([
      ['packages/core', '@mono/core'],
      ['packages/web', '@mono/web'],
    ]);
  });

  it('finds pnpm workspaces', () => {
    const dir = fixture(null, {
      files: {
        'package.json': '{"name":"r","private":true}',
        'pnpm-workspace.yaml': "packages:\n  - 'apps/*'\n",
        'apps/site/package.json': '{"name":"site"}',
      },
    });
    const ws = detectWorkspaces(createContext(dir));
    expect(ws?.kinds).toEqual(['pnpm']);
    expect(ws?.packages.map((p) => p.dir)).toEqual(['apps/site']);
  });

  it('finds Cargo workspace members and a root crate with code', () => {
    const rs = Object.fromEntries(
      Array.from({ length: 10 }, (_, i) => [`src/m${i}.rs`, `pub fn f${i}() {}\n`]),
    );
    const dir = fixture(null, {
      git: true,
      files: {
        'Cargo.toml': '[package]\nname = "tool"\n\n[workspace]\nmembers = ["crates/*"]\n',
        'crates/core/Cargo.toml': '[package]\nname = "tool-core"\n',
        'crates/core/src/lib.rs': 'pub fn x() {}\n',
        ...rs,
      },
    });
    const ws = detectWorkspaces(createContext(dir));
    expect(ws?.kinds).toEqual(['cargo']);
    expect(ws?.packages.map((p) => [p.dir, p.name, p.kind])).toEqual([
      ['.', 'tool', 'cargo'],
      ['crates/core', 'tool-core', 'cargo'],
    ]);
  });

  it('finds Go modules from go.work, or from nested go.mod files', () => {
    const work = fixture(null, {
      files: {
        'go.work': 'go 1.22\nuse (\n  ./api\n  ./missing\n)\n',
        'api/go.mod': 'module example.com/api\n',
        'api/main.go': 'package main\n',
      },
    });
    expect(detectWorkspaces(createContext(work))?.packages).toEqual([
      { dir: 'api', name: 'example.com/api', kind: 'go' },
    ]);
    const multi = fixture(null, {
      files: {
        'go.mod': 'module example.com/zap\n',
        'exp/go.mod': 'module example.com/zap/exp\n',
        'internal/testdata/go.mod': 'module ignored\n',
      },
    });
    expect(detectWorkspaces(createContext(multi))?.packages.map((p) => p.dir)).toEqual(['exp']);
  });
});

describe('package contexts', () => {
  it('see the package files plus inherited root configs', () => {
    const parent = createContext(jsMonorepo());
    const pkg = createPackageContext(parent, 'packages/core');
    expect(pkg.files).toContain('src/m0.ts');
    expect(pkg.files).toContain('biome.json');
    expect(pkg.files).not.toContain('packages/web/src/m0.ts');
    expect(pkg.read('biome.json')).toBe('{}');
    expect(pkg.exists('.gitignore')).toBe(true);
    // root scripts and hoisted dev tools apply to the package
    expect(pkg.scripts().test).toBe('vitest run');
    expect('vitest' in pkg.allDeps()).toBe(true);
    expect(pkg.isIgnored('node_modules')).toBe(true);
    expect(pkg.parent?.dir).toBe('packages/core');
  });
});

describe('monorepo scan', () => {
  it('scores each package and aggregates by code size', async () => {
    const r = await scan(jsMonorepo());
    const ws = r.workspaces;
    expect(ws?.total).toBe(2);
    const core = ws?.packages.find((p) => p.dir === 'packages/core');
    const web = ws?.packages.find((p) => p.dir === 'packages/web');
    expect(core?.score).toBe(100);
    expect(core?.categories.map((c) => c.id)).toEqual(['feedback', 'navigability', 'types']);
    // web: loose tsconfig and an oversized file
    expect(web?.score).toBeLessThan(90);
    expect(web?.issues.map((i) => i.id)).toEqual(
      expect.arrayContaining(['nav.large-files', 'types.typescript']),
    );
    const expected = Math.round(
      ((core?.score ?? 0) * (core?.codeFiles ?? 0) + (web?.score ?? 0) * (web?.codeFiles ?? 0)) /
        ((core?.codeFiles ?? 0) + (web?.codeFiles ?? 0)),
    );
    expect(ws?.aggregate).toBe(expected);
  });

  it('can be turned off, and is absent for single-package repos', async () => {
    expect((await scan(jsMonorepo(), { workspaces: false })).workspaces).toBeUndefined();
    expect((await scan(fixture('good-ts', { git: true }))).workspaces).toBeUndefined();
  });

  it('works without git', async () => {
    const dir = fixture(null, {
      files: {
        'package.json': JSON.stringify({ name: 'm', workspaces: ['packages/*'] }),
        'packages/a/package.json': JSON.stringify({ name: 'a', scripts: { test: 'vitest' } }),
        ...tsFiles('packages/a', 2),
      },
    });
    const r = await scan(dir);
    expect(r.workspaces?.packages[0]?.dir).toBe('packages/a');
    expect(r.workspaces?.packages[0]?.score).toBeTypeOf('number');
  });

  it('shows the per-package breakdown in the terminal report', async () => {
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
    await main([jsMonorepo()], io);
    expect(out).toMatch(/Workspaces\s+npm · 2 package\(s\) · aggregate \d+\/100/);
    expect(out).toMatch(/packages\/core\s+100/);
  });
});

describe('context.packages', () => {
  it('flags large packages neither documented nor mentioned', async () => {
    const r = await scan(jsMonorepo());
    const c = check(r, 'context.packages');
    expect(c.score).toBe(0);
    expect(c.findings?.map((f) => f.file)).toEqual(['packages/core/', 'packages/web/']);
  });

  it('passes with a nested AGENTS.md or a mention in the root docs', async () => {
    const r = await scan(
      jsMonorepo({
        'packages/core/AGENTS.md': '# core\n\nRun `npm test` here.\n',
        'AGENTS.md': `${ROOT_DOC}\nThe UI lives in \`@mono/web\`.\n`,
      }),
    );
    const c = check(r, 'context.packages');
    expect(c.score).toBe(1);
    expect(c.summary).toBe('2 of 2 packages documented (1 with their own AGENTS.md/CLAUDE.md)');
    expect(r.workspaces?.packages.find((p) => p.dir === 'packages/core')?.docs).toEqual([
      'packages/core/AGENTS.md',
    ]);
  });

  it('does not count prose words or longer paths as mentions', async () => {
    const r = await scan(
      jsMonorepo({
        'packages/core/package.json': JSON.stringify({ name: 'core' }),
        'AGENTS.md': `${ROOT_DOC}\nThe core idea is simple. See \`packages/web-old/\`.\n`,
      }),
    );
    expect(check(r, 'context.packages').score).toBe(0);
  });

  it('is n/a when every package is small', async () => {
    const dir = fixture(null, {
      git: true,
      files: {
        'package.json': JSON.stringify({ name: 'm', workspaces: ['packages/*'] }),
        'AGENTS.md': ROOT_DOC,
        'packages/a/package.json': '{"name":"a"}',
        ...tsFiles('packages/a', 3),
      },
    });
    expect(check(await scan(dir), 'context.packages').score).toBeNull();
  });
});
