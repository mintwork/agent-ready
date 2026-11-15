import { execFileSync } from 'node:child_process';
import { appendFileSync, mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { MIN_AGE_DAYS, MIN_COMMITS } from '../src/checks/doc-history.js';
import { scan } from '../src/scan.js';
import type { Report } from '../src/types.js';

// Synthetic repos with backdated commits; never real history.

function check(report: Report, id: string) {
  const c = report.checks.find((x) => x.id === id);
  if (!c) throw new Error(`no check ${id}`);
  return c;
}

const DAY = 86_400;
const T0 = 1_700_000_000;

class Repo {
  readonly dir = mkdtempSync(join(tmpdir(), 'agent-ready-history-'));
  private t = T0;

  constructor() {
    this.git('init', '-q');
    this.git('config', 'user.email', 't@example.com');
    this.git('config', 'user.name', 'T');
  }

  git(...args: string[]): string {
    const date = `${this.t} +0000`;
    return execFileSync('git', args, {
      cwd: this.dir,
      encoding: 'utf8',
      env: { ...process.env, GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date },
    });
  }

  write(rel: string, content: string): void {
    mkdirSync(dirname(join(this.dir, rel)), { recursive: true });
    writeFileSync(join(this.dir, rel), content);
  }

  commit(files: Record<string, string>, daysLater = 1): void {
    this.t += daysLater * DAY;
    for (const [rel, content] of Object.entries(files)) this.write(rel, content);
    this.git('add', '-A');
    this.git(
      '-c',
      'commit.gpgsign=false',
      'commit',
      '-q',
      '--allow-empty',
      '--no-verify',
      '-m',
      'c',
    );
  }

  /** `n` commits editing `rel`, one day apart. */
  churn(rel: string, n: number): void {
    for (let i = 0; i < n; i++) this.commit({ [rel]: `export const v = ${i + 1};\n` });
  }
}

const DOC = [
  '# AGENTS.md',
  '',
  '## Architecture',
  '',
  '- `src/engine.ts` — the core loop',
  '- `src/plugins/` — plugin modules',
  '',
].join('\n');

function base(): Repo {
  const r = new Repo();
  r.commit({
    'package.json': '{"name":"h","scripts":{"test":"vitest"}}',
    'src/engine.ts': 'export const v = 0;\n',
    'src/plugins/a.ts': 'export const a = 1;\n',
    'AGENTS.md': DOC,
  });
  return r;
}

describe('context.drift', () => {
  it('flags a doc left untouched while the files it names churned', async () => {
    const r = base();
    r.churn('src/engine.ts', MIN_COMMITS);
    r.commit({}, MIN_AGE_DAYS); // time passes
    r.commit({ 'README.md': 'x\n' });
    const c = check(await scan(r.dir), 'context.drift');
    expect(c.score).toBe(0.5);
    expect(c.findings?.[0]?.file).toBe('AGENTS.md');
    expect(c.findings?.[0]?.message).toMatch(
      new RegExp(`unchanged for \\d+ days while ${MIN_COMMITS} later commits`),
    );
    expect(c.findings?.[0]?.message).toContain('`src/engine.ts`');
  });

  it('passes when the doc was updated after the churn', async () => {
    const r = base();
    r.churn('src/engine.ts', MIN_COMMITS);
    r.commit({}, MIN_AGE_DAYS);
    r.commit({ 'AGENTS.md': `${DOC}\nUpdated.\n` });
    const c = check(await scan(r.dir), 'context.drift');
    expect(c.score).toBe(1);
    expect(c.summary).toBe('1 doc(s) kept up with the code they reference');
  });

  it('needs both age and churn', async () => {
    const young = base();
    young.churn('src/engine.ts', MIN_COMMITS + 5); // lots of churn, but within the window
    expect(check(await scan(young.dir), 'context.drift').score).toBe(1);
    const quiet = base();
    quiet.churn('src/engine.ts', 3);
    quiet.commit({}, MIN_AGE_DAYS * 3); // old, but the code barely changed
    expect(check(await scan(quiet.dir), 'context.drift').score).toBe(1);
  });

  it('counts only files added or removed under a referenced directory', async () => {
    const edits = base();
    edits.churn('src/plugins/a.ts', MIN_COMMITS); // edits inside a referenced dir
    edits.commit({}, MIN_AGE_DAYS);
    expect(check(await scan(edits.dir), 'context.drift').score).toBe(1);
    const structural = base();
    for (let i = 0; i < MIN_COMMITS; i++) structural.commit({ [`src/plugins/p${i}.ts`]: '1\n' });
    structural.commit({}, MIN_AGE_DAYS);
    expect(check(await scan(structural.dir), 'context.drift').score).toBe(0.5);
  });

  it('skips docs with uncommitted edits and follows symlinked docs', async () => {
    const r = base();
    r.churn('src/engine.ts', MIN_COMMITS);
    r.commit({}, MIN_AGE_DAYS);
    symlinkSync('AGENTS.md', join(r.dir, 'CLAUDE.md'));
    r.commit({});
    const before = check(await scan(r.dir), 'context.drift');
    // the symlink is the same doc: reported once, under its target
    expect(before.findings?.map((f) => f.file)).toEqual(['AGENTS.md']);
    appendFileSync(join(r.dir, 'AGENTS.md'), '\nWork in progress.\n');
    expect(check(await scan(r.dir), 'context.drift').score).toBeNull();
  });

  it('is n/a without git, in shallow clones and for docs without code references', async () => {
    const r = base();
    r.churn('src/engine.ts', 2);
    const shallow = mkdtempSync(join(tmpdir(), 'agent-ready-shallow-'));
    execFileSync('git', ['clone', '-q', '--depth', '1', `file://${r.dir}`, shallow]);
    expect(check(await scan(shallow), 'context.drift').summary).toMatch(/Shallow clone/);
    const plain = new Repo();
    plain.commit({ 'AGENTS.md': '# Hi\n\nJust prose.\n', 'a.ts': '1\n' });
    expect(check(await scan(plain.dir), 'context.drift').score).toBeNull();
  });
});
