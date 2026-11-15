import { describe, expect, it } from 'vitest';
import { parseMdcFrontmatter } from '../src/checks/agent-tooling.js';
import { scan } from '../src/scan.js';
import type { Report } from '../src/types.js';
import { fixture } from './helpers.js';

function check(report: Report, id: string) {
  const c = report.checks.find((x) => x.id === id);
  if (!c) throw new Error(`no check ${id}`);
  return c;
}

const json = (v: unknown) => JSON.stringify(v, null, 2);
/** Built from pieces so this file never holds a real-looking token. */
const FAKE_TOKEN = ['ghp', 'Zq4Lm8Rt2Wx6Np0Kv3Hs7'].join('_');

async function run(files: Record<string, string>): Promise<Report> {
  return scan(fixture('good-ts', { git: true, files }));
}

describe('tooling checks are n/a when the tool is not used', () => {
  it('never scores a repo without MCP, hooks, settings or Cursor rules', async () => {
    const r = await scan(fixture('good-ts', { git: true }));
    for (const id of [
      'feedback.mcp',
      'feedback.hooks',
      'safety.agent-permissions',
      'context.cursor-rules',
    ]) {
      expect(check(r, id).score).toBeNull();
    }
  });
});

describe('feedback.mcp', () => {
  it('passes for well-formed stdio and remote servers', async () => {
    const r = await run({
      '.mcp.json': json({
        mcpServers: {
          db: { command: 'node', args: ['./tools/mcp.js'], env: { DB_TOKEN: `\${DB_TOKEN}` } },
          docs: { type: 'http', url: 'https://example.com/mcp' },
          built: { command: 'node', args: ['./mcp/dist/index.js'] },
        },
      }),
      'tools/mcp.js': 'console.log(1);\n',
      '.vscode/mcp.json':
        '{\n  // VS Code allows comments\n  "servers": { "a": { "command": "npx" } }\n}\n',
    });
    const c = check(r, 'feedback.mcp');
    expect(c.score).toBe(1);
    expect(c.summary).toBe('4 MCP server(s) in .mcp.json, .vscode/mcp.json');
  });

  it('flags invalid JSON, missing commands/urls, missing scripts and literal secrets', async () => {
    const r = await run({
      '.mcp.json': json({
        mcpServers: {
          a: { args: ['x'] },
          b: { type: 'sse' },
          c: { command: 'python3', args: ['scripts/gone.py'] },
          d: { command: 'npx', env: { API_TOKEN: FAKE_TOKEN } },
        },
      }),
      '.cursor/mcp.json': '{ "mcpServers": ',
    });
    const c = check(r, 'feedback.mcp');
    const msgs = (c.findings ?? []).map((f) => `${f.file}: ${f.message}`);
    expect(msgs).toEqual(
      expect.arrayContaining([
        '.mcp.json: server "a": stdio server needs a "command"',
        '.mcp.json: server "b": remote server needs a "url"',
        '.mcp.json: server "c": runs `scripts/gone.py`, which does not exist',
        expect.stringMatching(/server "d": env API_TOKEN has a hard-coded value/),
        '.cursor/mcp.json: is not valid JSON',
      ]),
    );
    expect(c.score).toBe(0);
    // the secret value itself is never echoed
    expect(msgs.join('\n')).not.toContain(FAKE_TOKEN);
  });

  it('needs an mcpServers object', async () => {
    const c = check(await run({ '.mcp.json': json({ servers: {} }) }), 'feedback.mcp');
    expect(c.score).toBe(0.5);
    expect(c.findings?.[0]?.message).toBe('needs a "mcpServers" object');
  });
});

describe('feedback.hooks', () => {
  const settings = (hooks: unknown) => json({ hooks });

  it('passes for valid hooks whose scripts exist', async () => {
    const r = await run({
      '.claude/settings.json': settings({
        PostToolUse: [
          {
            matcher: 'Edit|Write',
            hooks: [{ type: 'command', command: '"$CLAUDE_PROJECT_DIR"/.claude/hooks/fmt.sh' }],
          },
        ],
        Stop: [{ hooks: [{ type: 'command', command: 'npm test --silent' }] }],
      }),
      '.claude/hooks/fmt.sh': '#!/bin/sh\n',
    });
    const c = check(r, 'feedback.hooks');
    expect(c.score).toBe(1);
    expect(c.summary).toBe('2 hook group(s) configured');
  });

  it('flags misspelled events, bad matchers, missing scripts and wrong shapes', async () => {
    const r = await run({
      '.claude/settings.json': settings({
        preToolUse: [{ matcher: 'Bash(', hooks: [{ type: 'command', command: './scripts/x.sh' }] }],
        PostToolUse: { matcher: '*' },
      }),
    });
    const msgs = (check(r, 'feedback.hooks').findings ?? []).map((f) => f.message);
    expect(msgs).toEqual(
      expect.arrayContaining([
        'hook event "preToolUse" should be "PreToolUse" (it never fires)',
        'hooks.preToolUse: matcher "Bash(" is not a valid regex',
        expect.stringMatching(/runs `scripts\/x\.sh`, which does not exist/),
        'hooks.PostToolUse must be an array of { matcher, hooks } groups',
      ]),
    );
    expect(check(r, 'feedback.hooks').score).toBe(0);
  });

  it('reports invalid settings JSON, and is n/a for settings without hooks', async () => {
    const bad = await run({ '.claude/settings.json': '{ "permissions": ' });
    expect(check(bad, 'feedback.hooks').score).toBe(0);
    const none = await run({ '.claude/settings.json': json({ permissions: { allow: [] } }) });
    expect(check(none, 'feedback.hooks').score).toBeNull();
  });
});

describe('safety.agent-permissions', () => {
  it('passes for narrowly scoped allow rules', async () => {
    const r = await run({
      '.claude/settings.json': json({
        permissions: { allow: ['Bash(npm test:*)', 'Bash(npm run lint)', 'Edit', 'WebFetch'] },
      }),
    });
    expect(check(r, 'safety.agent-permissions').score).toBe(1);
  });

  it('flags Bash(*), bypassPermissions, interpreters and auto-approved MCP servers', async () => {
    const r = await run({
      '.claude/settings.json': json({
        permissions: {
          defaultMode: 'bypassPermissions',
          allow: ['Bash(*)', 'Bash(python3:*)', 'Bash(rm *)', 'Bash(git status)'],
        },
        enableAllProjectMcpServers: true,
      }),
    });
    const c = check(r, 'safety.agent-permissions');
    const msgs = (c.findings ?? []).map((f) => f.message);
    expect(msgs).toEqual([
      expect.stringMatching(/bypassPermissions/),
      'allow rule `Bash(*)` lets the agent run any shell command without asking',
      'allow rule `Bash(python3:*)` pre-approves `python3` with any arguments',
      'allow rule `Bash(rm *)` pre-approves `rm` with any arguments',
      expect.stringMatching(/enableAllProjectMcpServers/),
    ]);
    expect(c.score).toBe(0);
  });

  it('treats a bare Bash allow rule as any command, and checks Codex config', async () => {
    const r = await run({
      '.claude/settings.json': json({ permissions: { allow: ['Bash'] } }),
      '.codex/config.toml':
        'approval_policy = "never"\nsandbox_mode = "danger-full-access"\n\n[mcp_servers.x]\ncommand = "y"\n',
    });
    const c = check(r, 'safety.agent-permissions');
    expect(c.findings?.map((f) => f.severity)).toEqual(['error', 'error']);
  });
});

describe('context.cursor-rules', () => {
  it('parses .mdc frontmatter with comma and YAML-list globs', () => {
    expect(
      parseMdcFrontmatter(
        '---\ndescription: API rules\nglobs: src/**/*.ts, *.tsx\nalwaysApply: false\n---\nBody',
      ).fm,
    ).toEqual({
      description: 'API rules',
      globs: ['src/**/*.ts', '*.tsx'],
      alwaysApply: false,
    });
    expect(parseMdcFrontmatter('---\nglobs:\n  - "lib/**"\n---\n').fm?.globs).toEqual(['lib/**']);
    expect(parseMdcFrontmatter('# no frontmatter').fm).toBeNull();
  });

  it('passes when every rule applies automatically', async () => {
    const r = await run({
      '.cursor/rules/always.mdc': '---\nalwaysApply: true\n---\nUse strict TS.\n',
      '.cursor/rules/ts.mdc': '---\nglobs: src/**/*.ts\n---\nPrefer named exports.\n',
      '.cursor/rules/db.mdc':
        '---\ndescription: When touching the database layer\n---\nUse migrations.\n',
    });
    expect(check(r, 'context.cursor-rules').score).toBe(1);
  });

  it('flags rules that never apply, stale globs and empty rules', async () => {
    const r = await run({
      '.cursor/rules/manual.mdc': 'Just text, no frontmatter.\n',
      '.cursor/rules/dead.mdc': '---\nalwaysApply: false\n---\nNever used.\n',
      '.cursor/rules/stale.mdc': '---\nglobs: legacy/**/*.coffee\n---\nOld.\n',
      '.cursor/rules/empty.mdc': '---\nalwaysApply: true\n---\n',
      '.cursor/rules/ok.mdc': '---\nalwaysApply: true\n---\nFine.\n',
      '.cursorrules': 'legacy\n',
    });
    const c = check(r, 'context.cursor-rules');
    expect(c.score).toBeCloseTo(0.2);
    const byFile = Object.fromEntries((c.findings ?? []).map((f) => [f.file, f]));
    expect(byFile['.cursor/rules/manual.mdc']?.message).toMatch(/only applies when @-mentioned/);
    expect(byFile['.cursor/rules/dead.mdc']?.message).toMatch(/never applies this rule/);
    expect(byFile['.cursor/rules/stale.mdc']?.message).toMatch(/match no files/);
    expect(byFile['.cursor/rules/empty.mdc']?.message).toBe('rule has no content');
    expect(byFile['.cursorrules']?.severity).toBe('info');
  });
});
