import { posix } from 'node:path';
import type { RepoContext } from '../context.js';
import type { Check, CheckResult, Finding } from '../types.js';
import { Matcher } from '../util/glob.js';
import { parseJsonc } from '../util/jsonc.js';

/**
 * Checks for the agent tooling a repo ships: MCP server configs, Claude Code hooks and permission
 * settings, Cursor rules. All of them are n/a when the tool isn't used, so a repo is never
 * penalized for not using a tool; they only score what is there.
 */

type Parsed = { ok: true; value: unknown; lenient: boolean } | { ok: false };

/** Strict JSON first (what the tools use); JSON with comments counts, but is flagged. */
function parseConfig(text: string): Parsed {
  try {
    return { ok: true, value: JSON.parse(text), lenient: false };
  } catch {
    const v = parseJsonc(text);
    return v === null ? { ok: false } : { ok: true, value: v, lenient: true };
  }
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** Score from findings: errors cost 0.5, warnings 0.2; info is free. */
function penaltyScore(findings: Finding[]): number {
  const p = findings.reduce(
    (n, f) => n + (f.severity === 'error' ? 0.5 : f.severity === 'warn' ? 0.2 : 0),
    0,
  );
  return Math.max(0, 1 - p);
}

const SECRET_KEY = /(KEY|TOKEN|SECRET|PASSWORD|PASSWD|PRIVATE|CREDENTIAL|AUTH)/i;
const PLACEHOLDER_VALUE = /^\$\{?[\w:-]+\}?$|^<.*>$|your[-_ ]|xxx|placeholder|changeme|example/i;

/** A literal value that looks like a real credential (not `${VAR}`, empty or a placeholder). */
function literalSecret(key: string, value: unknown): boolean {
  if (typeof value !== 'string' || !SECRET_KEY.test(key)) return false;
  const v = value.trim();
  return v.length >= 8 && !v.includes('${') && !PLACEHOLDER_VALUE.test(v);
}

const SCRIPT_EXT = /\.(?:sh|bash|py|m?js|cjs|ts|rb|pl)$/;

/** Relative script paths in a command line (`./scripts/x.sh`, `.claude/hooks/fmt.py`, `server/index.js`). */
function scriptPaths(command: string): string[] {
  const out: string[] = [];
  const cleaned = command.replace(/"?\$\{?CLAUDE_PROJECT_DIR\}?"?\/?/g, '');
  for (const raw of cleaned.split(/\s+/)) {
    const tok = raw.replace(/^['"]|['"]$/g, '');
    // Two linear tests rather than one nested pattern (which can backtrack on long tokens).
    if (!SCRIPT_EXT.test(tok) || !/^[\w./-]+$/.test(tok) || !tok.includes('/')) continue;
    if (tok.startsWith('/') || tok.includes('//')) continue;
    out.push(posix.normalize(tok));
  }
  return out;
}

const BUILD_OUTPUT = /(^|\/)(dist|build|out|target|lib|node_modules|\.venv|venv)\//;

/** A script path that should exist now: build output and gitignored paths appear after a build. */
function missingScript(ctx: RepoContext, p: string): boolean {
  if (ctx.exists(p) || BUILD_OUTPUT.test(p)) return false;
  return !ctx.isIgnored(p);
}

const MCP_FILES: Array<{ path: string; key: 'mcpServers' | 'servers'; tool: string }> = [
  { path: '.mcp.json', key: 'mcpServers', tool: 'Claude Code' },
  { path: '.cursor/mcp.json', key: 'mcpServers', tool: 'Cursor' },
  { path: '.vscode/mcp.json', key: 'servers', tool: 'VS Code / Copilot' },
];

/** Problems with one MCP server definition. */
function mcpServerFindings(
  ctx: RepoContext,
  file: string,
  name: string,
  server: unknown,
): Finding[] {
  const out: Finding[] = [];
  const at = (severity: Finding['severity'], message: string) =>
    out.push({ severity, file, message: `server "${name}": ${message}` });
  if (!isObject(server)) {
    at('error', 'must be an object');
    return out;
  }
  const type = server.type;
  const remote = type === 'http' || type === 'sse' || (type === undefined && 'url' in server);
  if (type !== undefined && !['stdio', 'http', 'sse'].includes(String(type))) {
    at('warn', `unknown transport type "${String(type)}" (expected stdio, http or sse)`);
  }
  if (remote) {
    const url = server.url;
    if (typeof url !== 'string' || !url.trim()) at('error', 'remote server needs a "url"');
    else if (!/^(?:https?:\/\/|\$\{)/.test(url)) at('error', `"url" is not an http(s) URL`);
    const headers = isObject(server.headers) ? server.headers : {};
    for (const [k, v] of Object.entries(headers)) {
      if (typeof v === 'string' && /^(?:Bearer|Basic|token)\s+(?!\$\{)\S{8,}/i.test(v)) {
        at('warn', `header "${k}" has a hard-coded credential; use \${ENV_VAR} expansion`);
      }
    }
  } else {
    const command = server.command;
    if (typeof command !== 'string' || !command.trim()) {
      at('error', 'stdio server needs a "command"');
    } else {
      const args = server.args;
      if (args !== undefined && (!Array.isArray(args) || args.some((a) => typeof a !== 'string'))) {
        at('error', '"args" must be an array of strings');
      }
      const line = [command, ...(Array.isArray(args) ? args.map(String) : [])].join(' ');
      for (const p of scriptPaths(line)) {
        if (missingScript(ctx, p)) at('error', `runs \`${p}\`, which does not exist`);
      }
    }
  }
  if (server.env !== undefined && !isObject(server.env)) at('error', '"env" must be an object');
  for (const [k, v] of Object.entries(isObject(server.env) ? server.env : {})) {
    if (literalSecret(k, v)) {
      at('warn', `env ${k} has a hard-coded value; use \${${k}} so the secret stays out of git`);
    }
  }
  return out;
}

const mcpCheck: Check = {
  id: 'feedback.mcp',
  category: 'feedback',
  title: 'MCP server configs are valid',
  weight: 1,
  run(ctx): CheckResult {
    const present = MCP_FILES.filter((f) => ctx.has(f.path));
    if (present.length === 0) return { score: null, summary: 'No project MCP config' };
    const findings: Finding[] = [];
    let servers = 0;
    let fileScores = 0;
    for (const f of present) {
      const own: Finding[] = [];
      const parsed = parseConfig(ctx.read(f.path) ?? '');
      if (!parsed.ok) {
        own.push({ severity: 'error', file: f.path, message: 'is not valid JSON' });
      } else {
        if (parsed.lenient) {
          own.push({
            severity: f.path === '.vscode/mcp.json' ? 'info' : 'warn',
            file: f.path,
            message: 'has comments or trailing commas; strict JSON parsers will reject it',
          });
        }
        const map = isObject(parsed.value) ? parsed.value[f.key] : undefined;
        if (!isObject(map)) {
          own.push({ severity: 'error', file: f.path, message: `needs a "${f.key}" object` });
        } else {
          for (const [name, server] of Object.entries(map)) {
            servers++;
            own.push(...mcpServerFindings(ctx, f.path, name, server));
          }
        }
      }
      // An unparseable config is dropped entirely by the tool.
      fileScores += parsed.ok ? penaltyScore(own) : 0;
      findings.push(...own);
    }
    const score = fileScores / present.length;
    const problems = findings.filter((f) => f.severity !== 'info').length;
    return {
      score,
      summary:
        problems === 0
          ? `${servers} MCP server(s) in ${present.map((f) => f.path).join(', ')}`
          : `${problems} problem(s) in ${present.map((f) => f.path).join(', ')}`,
      findings,
      suggestion:
        score < 1
          ? `Fix the MCP config: a broken server silently disappears from the agent’s tools. Keep secrets in \`\${ENV_VAR}\` expansions, not in the file.`
          : undefined,
    };
  },
};

/** Claude Code settings files an agent session in this repo will load. */
const CLAUDE_SETTINGS = ['.claude/settings.json', '.claude/settings.local.json'];

const HOOK_EVENTS = [
  'PreToolUse',
  'PostToolUse',
  'PostToolUseFailure',
  'PermissionRequest',
  'UserPromptSubmit',
  'Notification',
  'Stop',
  'SubagentStart',
  'SubagentStop',
  'PreCompact',
  'SessionStart',
  'SessionEnd',
];

function hookFindings(ctx: RepoContext, file: string, hooks: unknown): Finding[] {
  const out: Finding[] = [];
  const at = (severity: Finding['severity'], message: string) =>
    out.push({ severity, file, message });
  if (!isObject(hooks)) {
    at('error', '"hooks" must be an object keyed by event name');
    return out;
  }
  for (const [event, groups] of Object.entries(hooks)) {
    if (!HOOK_EVENTS.includes(event)) {
      const typo = HOOK_EVENTS.find((e) => e.toLowerCase() === event.toLowerCase());
      if (typo) at('error', `hook event "${event}" should be "${typo}" (it never fires)`);
      else at('info', `unknown hook event "${event}"`);
    }
    if (!Array.isArray(groups)) {
      at('error', `hooks.${event} must be an array of { matcher, hooks } groups`);
      continue;
    }
    for (const group of groups) {
      if (!isObject(group) || !Array.isArray(group.hooks)) {
        at('error', `hooks.${event}: each entry needs a "hooks" array`);
        continue;
      }
      if (typeof group.matcher === 'string' && group.matcher && group.matcher !== '*') {
        try {
          new RegExp(group.matcher);
        } catch {
          at('error', `hooks.${event}: matcher "${group.matcher}" is not a valid regex`);
        }
      }
      for (const h of group.hooks) {
        if (!isObject(h)) {
          at('error', `hooks.${event}: hook must be an object`);
          continue;
        }
        if (h.type === 'command') {
          if (typeof h.command !== 'string' || !h.command.trim()) {
            at('error', `hooks.${event}: command hook needs a "command"`);
            continue;
          }
          for (const p of scriptPaths(h.command)) {
            if (missingScript(ctx, p)) {
              at(
                'error',
                `hooks.${event} runs \`${p}\`, which does not exist (the hook fails on every run)`,
              );
            }
          }
        } else if (h.type !== 'prompt' && h.type !== 'agent') {
          at('warn', `hooks.${event}: unknown hook type "${String(h.type)}"`);
        }
      }
    }
  }
  return out;
}

const hooksCheck: Check = {
  id: 'feedback.hooks',
  category: 'feedback',
  title: 'Claude Code hooks are valid',
  weight: 1,
  run(ctx): CheckResult {
    const findings: Finding[] = [];
    let groups = 0;
    let applies = false;
    let broken = false;
    for (const file of CLAUDE_SETTINGS.filter((f) => ctx.has(f))) {
      const parsed = parseConfig(ctx.read(file) ?? '');
      if (!parsed.ok) {
        applies = true;
        broken = true;
        findings.push({
          severity: 'error',
          file,
          message: 'is not valid JSON; Claude Code ignores its hooks and permissions',
        });
        continue;
      }
      const hooks = isObject(parsed.value) ? parsed.value.hooks : undefined;
      if (hooks === undefined) continue;
      applies = true;
      if (isObject(hooks)) groups += Object.values(hooks).flat().length;
      findings.push(...hookFindings(ctx, file, hooks));
    }
    if (!applies) return { score: null, summary: 'No Claude Code hooks configured' };
    const score = broken ? 0 : penaltyScore(findings);
    const problems = findings.filter((f) => f.severity !== 'info').length;
    return {
      score,
      summary:
        problems === 0 ? `${groups} hook group(s) configured` : `${problems} hook problem(s)`,
      findings,
      suggestion:
        score < 1
          ? 'Broken hooks fail on every tool call or never fire. Fix event names, matchers and script paths (use "$CLAUDE_PROJECT_DIR"/path for scripts).'
          : undefined,
    };
  },
};

/** Allow rules that let the agent run anything without asking. */
const ANY_COMMAND = /^Bash(?:\((?:\*|:\*|\*\*|\s*)\))?$/;
/** Commands that are a shell, an interpreter or destructive: allowing them with any args is a blank check. */
const RISKY_PREFIX =
  /^Bash\((sudo|su|rm|curl|wget|bash|sh|zsh|fish|eval|exec|xargs|python3?|node|deno|bun|ruby|perl|php|ssh|scp|dd|chmod|chown|git push|npm publish|pnpm publish|yarn publish|docker|kubectl|terraform)(?::\*|\s\*|\*)\)$/;

function claudePermissionFindings(file: string, settings: Record<string, unknown>): Finding[] {
  const out: Finding[] = [];
  const perms = isObject(settings.permissions) ? settings.permissions : {};
  if (perms.defaultMode === 'bypassPermissions') {
    out.push({
      severity: 'error',
      file,
      message:
        'permissions.defaultMode is "bypassPermissions": every tool runs without asking, for everyone who opens the repo',
    });
  }
  const allow = Array.isArray(perms.allow) ? perms.allow.filter((r) => typeof r === 'string') : [];
  for (const rule of allow as string[]) {
    const r = rule.trim();
    if (ANY_COMMAND.test(r)) {
      out.push({
        severity: 'error',
        file,
        message: `allow rule \`${r}\` lets the agent run any shell command without asking`,
      });
    } else {
      const m = RISKY_PREFIX.exec(r);
      if (m) {
        out.push({
          severity: 'warn',
          file,
          message: `allow rule \`${r}\` pre-approves \`${m[1]}\` with any arguments`,
        });
      }
    }
  }
  if (settings.enableAllProjectMcpServers === true) {
    out.push({
      severity: 'warn',
      file,
      message:
        'enableAllProjectMcpServers auto-approves every server in .mcp.json, including ones a PR adds',
    });
  }
  return out;
}

const permissionsCheck: Check = {
  id: 'safety.agent-permissions',
  category: 'safety',
  title: 'Agent permissions are scoped',
  weight: 1,
  run(ctx): CheckResult {
    const findings: Finding[] = [];
    const checked: string[] = [];
    for (const file of CLAUDE_SETTINGS.filter((f) => ctx.has(f))) {
      const parsed = parseConfig(ctx.read(file) ?? '');
      if (!parsed.ok || !isObject(parsed.value)) continue; // reported by feedback.hooks
      checked.push(file);
      if (file.endsWith('settings.local.json')) {
        findings.push({
          severity: 'info',
          file,
          message: 'personal settings file is visible; it is usually gitignored',
        });
      }
      findings.push(...claudePermissionFindings(file, parsed.value));
    }
    const codex = '.codex/config.toml';
    if (ctx.has(codex)) {
      checked.push(codex);
      const toml = ctx.read(codex) ?? '';
      const top = toml.split(/^\s*\[/m)[0] ?? '';
      if (/^\s*sandbox_mode\s*=\s*["']danger-full-access["']/m.test(top)) {
        findings.push({
          severity: /^\s*approval_policy\s*=\s*["']never["']/m.test(top) ? 'error' : 'warn',
          file: codex,
          message:
            'sandbox_mode = "danger-full-access" gives Codex unsandboxed access to the machine',
        });
      }
    }
    if (checked.length === 0)
      return { score: null, summary: 'No committed agent permission settings' };
    const score = penaltyScore(findings);
    const problems = findings.filter((f) => f.severity !== 'info').length;
    return {
      score,
      summary:
        problems === 0
          ? `Permissions in ${checked.join(', ')} are scoped`
          : `${problems} overly broad permission(s)`,
      findings,
      suggestion:
        score < 1
          ? 'Committed settings apply to everyone who opens the repo. Allow specific commands (`Bash(npm test:*)`), not shells, interpreters or `Bash(*)`; keep personal overrides in .claude/settings.local.json.'
          : undefined,
    };
  },
};

interface Frontmatter {
  description?: string;
  globs?: string[];
  alwaysApply?: boolean;
}

/** Cursor's `.mdc` frontmatter: `description`, `globs` (comma list or YAML list), `alwaysApply`. */
export function parseMdcFrontmatter(text: string): { fm: Frontmatter | null; body: string } {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(text);
  if (!m) return { fm: null, body: text };
  const fm: Frontmatter = {};
  const lines = (m[1] ?? '').split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const kv = /^(\w+)\s*:\s*(.*)$/.exec(lines[i] ?? '');
    if (!kv) continue;
    const key = kv[1];
    const value = (kv[2] ?? '').trim();
    if (key === 'description') fm.description = value.replace(/^['"]|['"]$/g, '');
    else if (key === 'alwaysApply') fm.alwaysApply = /^true$/i.test(value);
    else if (key === 'globs') {
      const list: string[] = [];
      if (value) {
        list.push(...value.replace(/^\[|\]$/g, '').split(','));
      } else {
        while (/^\s+-\s*/.test(lines[i + 1] ?? ''))
          list.push((lines[++i] ?? '').replace(/^\s+-\s*/, ''));
      }
      fm.globs = list.map((g) => g.trim().replace(/^['"]|['"]$/g, '')).filter(Boolean);
    }
  }
  return { fm, body: text.slice(m[0].length) };
}

const cursorRulesCheck: Check = {
  id: 'context.cursor-rules',
  category: 'context',
  title: 'Cursor rules are well-formed',
  weight: 1,
  run(ctx): CheckResult {
    const rules = ctx.files.filter((f) => /^\.cursor\/rules\/.+\.mdc$/.test(f));
    const findings: Finding[] = [];
    if (ctx.has('.cursorrules')) {
      findings.push({
        severity: 'info',
        file: '.cursorrules',
        message: 'legacy .cursorrules; Cursor now reads .cursor/rules/*.mdc',
      });
    }
    if (rules.length === 0) {
      return { score: null, summary: 'No .cursor/rules', findings };
    }
    let bad = 0;
    for (const f of rules) {
      const text = ctx.read(f);
      if (text === null) continue;
      const { fm, body } = parseMdcFrontmatter(text);
      const own: Finding[] = [];
      if (!body.trim()) own.push({ severity: 'warn', file: f, message: 'rule has no content' });
      if (!fm) {
        own.push({
          severity: 'warn',
          file: f,
          message:
            'no frontmatter: the rule only applies when @-mentioned (add description, globs or alwaysApply)',
        });
      } else if (!fm.alwaysApply && !fm.description && !fm.globs?.length) {
        own.push({
          severity: 'warn',
          file: f,
          message:
            'no description, globs or alwaysApply: Cursor never applies this rule on its own',
        });
      } else if (!fm.alwaysApply && fm.globs?.length) {
        const m = new Matcher(fm.globs);
        if (!ctx.files.some((p) => !p.startsWith('.cursor/') && m.matches(p))) {
          own.push({
            severity: 'warn',
            file: f,
            message: `globs ${fm.globs.map((g) => `\`${g}\``).join(', ')} match no files (stale rule?)`,
          });
        }
      }
      if (own.length) bad++;
      findings.push(...own);
    }
    const score = 1 - bad / rules.length;
    return {
      score,
      summary:
        bad === 0
          ? `${rules.length} Cursor rule(s), all applied automatically`
          : `${bad} of ${rules.length} Cursor rule(s) never apply on their own or are stale`,
      findings,
      suggestion:
        score < 1
          ? 'Give every .cursor/rules/*.mdc a frontmatter with a `description` (agent-requested), `globs` that match real files, or `alwaysApply: true`.'
          : undefined,
    };
  },
};

export const agentToolingChecks: Check[] = [
  cursorRulesCheck,
  mcpCheck,
  hooksCheck,
  permissionsCheck,
];
