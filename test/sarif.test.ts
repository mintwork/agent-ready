import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { main } from '../src/cli.js';
import { toSarif } from '../src/report/sarif.js';
import { scan } from '../src/scan.js';
import { FAKE_AWS_KEY, fixture } from './helpers.js';

interface SarifResult {
  ruleId: string;
  ruleIndex: number;
  level: string;
  message: { text: string };
  locations?: Array<{
    physicalLocation: { artifactLocation: { uri: string }; region?: { startLine: number } };
  }>;
}
interface SarifLog {
  version: string;
  runs: Array<{
    tool: { driver: { name: string; rules: Array<{ id: string; properties: object }> } };
    results: SarifResult[];
  }>;
}

function capture() {
  let out = '';
  let err = '';
  return {
    io: {
      stdout: {
        write: (s: string) => {
          out += s;
          return true;
        },
        isTTY: false,
      },
      stderr: {
        write: (s: string) => {
          err += s;
          return true;
        },
      },
    },
    out: () => out,
    err: () => err,
  };
}

function uris(log: SarifLog): string[] {
  return log.runs[0]?.results.flatMap(
    (r) => r.locations?.map((l) => l.physicalLocation.artifactLocation.uri) ?? [],
  ) as string[];
}

describe('SARIF output', () => {
  it('reports every check as a rule and only failing checks as results', async () => {
    const dir = fixture('bad-js', {
      git: true,
      files: { 'lib/config.js': `module.exports = { key: '${FAKE_AWS_KEY}' };\n` },
    });
    const report = await scan(dir);
    const log = toSarif(report, { fallbackFile: 'CLAUDE.md' }) as SarifLog;
    expect(log.version).toBe('2.1.0');
    const run = log.runs[0];
    if (!run) throw new Error('no run');
    expect(run.tool.driver.name).toBe('agent-ready');
    expect(run.tool.driver.rules.map((r) => r.id)).toEqual(report.checks.map((c) => c.id));

    const failing = new Set(
      report.checks
        .filter((c) => c.score !== null && c.score < 0.999 && c.summary !== 'needs a context file')
        .map((c) => c.id),
    );
    expect(new Set(run.results.map((r) => r.ruleId))).toEqual(failing);
    for (const r of run.results) {
      expect(run.tool.driver.rules[r.ruleIndex]?.id).toBe(r.ruleId);
      // code scanning needs a location for every result
      expect(r.locations?.length).toBe(1);
    }

    const secret = run.results.find((r) => r.ruleId === 'safety.secrets');
    expect(secret?.level).toBe('error');
    expect(secret?.locations?.[0]?.physicalLocation).toEqual({
      artifactLocation: { uri: 'lib/config.js', uriBaseId: '%SRCROOT%' },
      region: { startLine: 1 },
    });
    const rule = run.tool.driver.rules.find((r) => r.id === 'safety.secrets');
    expect(rule?.properties).toMatchObject({ 'security-severity': '8.0' });
    // a repo-level failure (no file) is anchored at the fallback file
    const ci = run.results.find((r) => r.ruleId === 'feedback.ci');
    expect(ci?.locations?.[0]?.physicalLocation.artifactLocation.uri).toBe('CLAUDE.md');
    expect(ci?.message.text).toMatch(/CI runs checks: No CI config found/);
  });

  it('reports a missing context file once, not once per context check', async () => {
    const log = toSarif(await scan(fixture('bad-py', { git: true }))) as SarifLog;
    const ctxResults = log.runs[0]?.results.filter((r) => r.ruleId.startsWith('context.'));
    expect(ctxResults?.map((r) => r.ruleId)).toEqual(['context.exists']);
  });

  it('never reports info findings (test dummies) and is empty for a clean repo', async () => {
    const dir = fixture('good-ts', {
      git: true,
      files: { 'test/keys.test.ts': `export const k = '${FAKE_AWS_KEY}';\n` },
    });
    const log = toSarif(await scan(dir)) as SarifLog;
    expect(uris(log)).not.toContain('test/keys.test.ts');
  });

  it('prefixes locations with a uri prefix', async () => {
    const report = await scan(fixture('bad-js', { git: true }));
    const log = toSarif(report, { uriPrefix: 'packages/web', fallbackFile: 'CLAUDE.md' });
    for (const u of uris(log as SarifLog)) expect(u.startsWith('packages/web/')).toBe(true);
  });

  it('--sarif prints SARIF relative to the git root when scanning a subdirectory', async () => {
    const root = mkdtempSync(join(tmpdir(), 'agent-ready-sarif-'));
    mkdirSync(join(root, 'apps/web'), { recursive: true });
    writeFileSync(join(root, 'apps/web/package.json'), '{"name":"web"}\n');
    writeFileSync(join(root, 'apps/web/index.js'), 'module.exports = 1;\n');
    execFileSync('git', ['init', '-q'], { cwd: root });
    execFileSync('git', ['add', '-A'], { cwd: root });
    const t = capture();
    expect(await main([join(root, 'apps/web'), '--sarif'], t.io)).toBe(0);
    const log = JSON.parse(t.out()) as SarifLog;
    expect(log.version).toBe('2.1.0');
    const all = uris(log);
    expect(all.length).toBeGreaterThan(0);
    for (const u of all) expect(u.startsWith('apps/web/')).toBe(true);
  });

  it('--sarif keeps --fix output off stdout and rejects --json', async () => {
    const t = capture();
    await main([fixture('bad-py'), '--sarif', '--fix', '--dry-run'], t.io);
    expect(() => JSON.parse(t.out())).not.toThrow();
    expect(t.err()).toContain('Would write AGENTS.md');
    expect(await main([fixture('bad-py'), '--sarif', '--json'], capture().io)).toBe(2);
  });
});
