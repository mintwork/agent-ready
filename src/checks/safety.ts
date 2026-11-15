import type { RepoContext } from '../context.js';
import { envExampleFix } from '../fix/env-example.js';
import type { Check, CheckResult, Finding } from '../types.js';
import { isExamplePath, isTestPath } from '../util/paths.js';

interface SecretRule {
  name: string;
  re: RegExp;
}

// Patterns are assembled from pieces so this file doesn't flag itself.
const SECRET_RULES: SecretRule[] = [
  { name: 'AWS access key', re: new RegExp(`\\b(?:AK${'IA'}|AS${'IA'})[0-9A-Z]{16}\\b`) },
  {
    name: 'GitHub token',
    re: new RegExp(`\\bgh[pousr]_[A-Za-z0-9]{36,}\\b|github_${'pat'}_[A-Za-z0-9_]{50,}`),
  },
  { name: 'Slack token', re: new RegExp(`\\bxo${'x'}[baprs]-[A-Za-z0-9-]{10,}`) },
  {
    name: 'Private key',
    re: new RegExp(
      // Require a real base64 body so docs/parsers that only mention the header don't match.
      `-----BEGIN (?:RSA |EC |OPENSSH |DSA |PGP |ENCRYPTED )?PRIVATE ${'KEY'}(?: BLOCK)?-----(?:\\\\[rn]|\\s)+(?:[\\w-]+: [^\\n]*\\n)*[A-Za-z0-9+/=]{40,}`,
    ),
  },
  { name: 'Stripe live key', re: new RegExp(`\\b[sr]k_${'live'}_[0-9a-zA-Z]{20,}`) },
  { name: 'Anthropic API key', re: new RegExp(`\\bsk-${'ant'}-[A-Za-z0-9_-]{20,}`) },
  {
    name: 'OpenAI API key',
    re: new RegExp(
      `\\bsk-(?:proj-|svcacct-)?[A-Za-z0-9_-]{20,}T3Blbk${'FJ'}[A-Za-z0-9_-]{20,}|\\bsk-proj-[A-Za-z0-9_-]{40,}`,
    ),
  },
  { name: 'Google API key', re: new RegExp(`\\bAI${'za'}[0-9A-Za-z_-]{35}\\b`) },
  { name: 'npm token', re: new RegExp(`\\bnp${'m'}_[A-Za-z0-9]{36}\\b`) },
];

const PLACEHOLDER = /EXAMPLE|example|xxxx|XXXX|your[-_]?|<|placeholder|dummy|fake|redacted/i;
/** Words near a match that mark it as a test/demo value (`fn test_key()`, `"<redacted>"`, `FakeClient`). */
const TEST_CONTEXT = /test|fake|dummy|mock|example|sample|redact|placeholder|fixture/i;
const SUPPRESS = 'agent-ready-ignore';

const SECRET_HINT = new RegExp(
  `AK${'IA'}|AS${'IA'}|gh[pousr]_|github_${'pat'}|xo${'x'}|PRIVATE ${'KEY'}|_${'live'}_|sk-|AI${'za'}|np${'m'}_`,
);

const SECRET_FILES: Array<{ re: RegExp; name: string; content?: boolean }> = [
  {
    re: /(^|\/)\.env(\.(?:local|prod|production|staging|live)(?:\.(?!example$|sample$|template$|dist$|defaults?$)[\w-]+)*)?$/,
    name: 'dotenv file',
  },
  { re: /(^|\/)id_(rsa|dsa|ecdsa|ed25519)$/, name: 'SSH private key' },
  { re: /\.(pem|key)$/, name: 'private key file', content: true },
  { re: /\.(p12|pfx|keystore|jks)$/, name: 'key store file' },
  { re: /(^|\/)(credentials|service-account|secrets?)\.json$/, name: 'credentials file' },
  { re: /(^|\/)\.(netrc|pgpass|htpasswd)$/, name: 'credentials file' },
];

const BINARY_EXT =
  /\.(png|jpe?g|gif|webp|ico|pdf|zip|gz|tgz|woff2?|ttf|eot|mp[34]|mov|wasm|so|dylib|dll|exe|bin|lockb|sqlite|db)$/i;

/** Non-production dotenv files (.env.test, .env.development, ...) are often committed with dummy values. */
const SOFT_ENV_FILE = /(^|\/)\.env\.[\w.-]+$/;
const TEMPLATE_ENV_FILE = /\.(?:example|sample|template|dist|defaults?)$/;
const SECRET_KEY_NAME = /(KEY|TOKEN|SECRET|PASSWORD|PASSWD|HASH|PRIVATE|CREDENTIAL)/i;
const DUMMY_VALUE =
  /^(?:test|testing|dummy|fake|mock|changeme|change-me|password|secret|local|dev|none|null|x+|\*+|0+|1234\d*)$|test|dummy|fake|mock|example|xxx|placeholder|your/i;

function softEnvFinding(f: string, text: string): Finding | null {
  for (const [i, raw] of text.split('\n').entries()) {
    const m = /^\s*(?:export\s+)?([A-Za-z_]\w*)\s*=\s*(.*)$/.exec(raw);
    if (!m) continue;
    const key = m[1] ?? '';
    const value = (m[2] ?? '').trim().replace(/^['"]|['"]$/g, '');
    // NEXT_PUBLIC_/VITE_/PUBLIC_ values are shipped to the browser by design.
    if (/^(?:NEXT_PUBLIC|VITE|PUBLIC|EXPO_PUBLIC|REACT_APP|NUXT_PUBLIC)_/.test(key)) continue;
    if (
      SECRET_KEY_NAME.test(key) &&
      value.length >= 6 &&
      !DUMMY_VALUE.test(value) &&
      !value.startsWith('$')
    ) {
      return {
        severity: 'warn',
        file: f,
        line: i + 1,
        message: `${key} has a real-looking value in a committed env file`,
      };
    }
  }
  return null;
}

/**
 * Secrets found in tests, fixtures or next to words like "test"/"fake"/"redacted" are almost always
 * deliberate dummies. They are reported as `info` (visible with --verbose) and don't affect the score.
 */
function testish(f: string, text: string, index: number): boolean {
  if (isTestPath(f)) return true;
  // Look at the matching line, the three before it and the one after it.
  const eol = text.indexOf('\n', index);
  const lineEnd = eol === -1 ? -1 : text.indexOf('\n', eol + 1);
  let ctxStart = index;
  for (let i = 0; i < 3 && ctxStart > 0; i++) ctxStart = text.lastIndexOf('\n', ctxStart - 1);
  return TEST_CONTEXT.test(text.slice(Math.max(0, ctxStart), lineEnd === -1 ? undefined : lineEnd));
}

function matchSecret(text: string): { rule: SecretRule; index: number; line: string } | null {
  for (const rule of SECRET_RULES) {
    const m = rule.re.exec(text);
    if (!m) continue;
    const lineStart = text.lastIndexOf('\n', m.index) + 1;
    const lineEnd = text.indexOf('\n', m.index);
    const line = text.slice(lineStart, lineEnd === -1 ? undefined : lineEnd);
    if (PLACEHOLDER.test(m[0]) || line.includes(SUPPRESS)) continue;
    return { rule, index: m.index, line };
  }
  return null;
}

export async function scanSecrets(ctx: RepoContext): Promise<Finding[]> {
  const findings: Finding[] = [];
  const toScan: string[] = [];
  for (const f of ctx.files) {
    const fileRule = SECRET_FILES.find((r) => r.re.test(f));
    // Nested .env files under examples/ or tests are usually templates; judge them by content.
    const softEnv =
      SOFT_ENV_FILE.test(f) ||
      (fileRule?.name === 'dotenv file' && (isExamplePath(f) || isTestPath(f)));
    if (softEnv) {
      if (TEMPLATE_ENV_FILE.test(f)) continue;
      const soft = softEnvFinding(f, ctx.read(f) ?? '');
      const demo = isTestPath(f) || isExamplePath(f);
      if (soft) findings.push(demo ? { ...soft, severity: 'info' } : soft);
      continue;
    }
    if (fileRule && !fileRule.content) {
      findings.push({
        severity: isTestPath(f) ? 'info' : 'error',
        file: f,
        message: `${fileRule.name} is visible in the repo`,
      });
      continue;
    }
    // Content hits in tests/fixtures would only ever be `info`; skipping them keeps big repos fast.
    if (isTestPath(f)) continue;
    if (
      BINARY_EXT.test(f) ||
      /(^|\/)(package-lock\.json|yarn\.lock|pnpm-lock\.yaml|poetry\.lock|uv\.lock)$/.test(f)
    )
      continue;
    toScan.push(f);
  }
  const hits = await ctx.mapFiles(toScan, (f, text): Finding | null => {
    // Cheap prefilter: every rule needs one of these literals.
    if (!SECRET_HINT.test(text)) return null;
    const hit = matchSecret(text);
    if (!hit) return null;
    const fileRule = SECRET_FILES.find((r) => r.re.test(f));
    return {
      severity: testish(f, text, hit.index) ? 'info' : 'error',
      file: f,
      line: text.slice(0, hit.index).split('\n').length,
      message: fileRule ? `${fileRule.name} contains a private key` : `possible ${hit.rule.name}`,
    };
  });
  for (const h of hits) if (h) findings.push(h);
  return findings;
}

interface DangerRule {
  re: RegExp;
  why: string;
  /** A script whose name contains one of these words is honest about what it does (`git-reset`, `clean`). */
  selfDescribing?: RegExp;
}

const DANGER_RULES: DangerRule[] = [
  {
    re: /\brm\s+-[a-zA-Z]*r[a-zA-Z]*f?[a-zA-Z]*\s+(?:--no-preserve-root\s+)?(?:\/(?:\s|$|\*)|~\/?(?:\s|$)|\$HOME\b|\$\{HOME\}|\.\.\/)/,
    why: 'recursive delete outside the repo',
  },
  {
    re: /\b(?:curl|wget)\b[^|;&]*\|\s*(?:sudo\s+)?(?:ba|z)?sh\b/,
    why: 'pipes a remote script into a shell',
  },
  { re: /\bsudo\b/, why: 'uses sudo' },
  { re: /\bchmod\s+(?:-R\s+)?0?777\b/, why: 'world-writable permissions' },
  {
    re: /\bgit\s+push\b[^;&|]*(?:--force\b|-f\b)/,
    why: 'force-pushes',
    selfDescribing: /push|release|deploy|publish/i,
  },
  { re: /\bgit\s+reset\s+--hard\b/, why: 'discards local changes', selfDescribing: /reset|clean/i },
  {
    re: /\bgit\s+clean\s+-[a-zA-Z]*f/,
    why: 'deletes untracked files',
    selfDescribing: /clean|reset|nuke|wipe/i,
  },
  { re: /\bDROP\s+(?:DATABASE|SCHEMA)\b/i, why: 'drops a database' },
  {
    re: /\bdocker\s+system\s+prune\b/,
    why: 'prunes all docker data',
    selfDescribing: /prune|clean|nuke/i,
  },
];

const PUBLISH = /\b(?:npm|pnpm|yarn)\s+publish\b|\btwine\s+upload\b|\bpoetry\s+publish\b/;
const RISKY_FOR_PUBLISH = new Set([
  'test',
  'build',
  'lint',
  'dev',
  'start',
  'check',
  'typecheck',
  'prepare',
  'postinstall',
  'install',
  'preinstall',
  'format',
]);

/** True if a package.json script is destructive or publishes — never recommend it to agents. */
export function isDangerousScript(body: string): boolean {
  return PUBLISH.test(body) || DANGER_RULES.some((r) => r.why !== 'uses sudo' && r.re.test(body));
}

export function scanScripts(ctx: RepoContext): Finding[] {
  const findings: Finding[] = [];
  for (const [name, body] of Object.entries(ctx.scripts())) {
    for (const rule of DANGER_RULES) {
      if (rule.selfDescribing?.test(name)) continue;
      if (rule.re.test(body))
        findings.push({
          severity: 'warn',
          file: 'package.json',
          message: `script "${name}" ${rule.why}: \`${body.slice(0, 80)}\``,
        });
    }
    if (RISKY_FOR_PUBLISH.has(name) && PUBLISH.test(body)) {
      findings.push({
        severity: 'warn',
        file: 'package.json',
        message: `script "${name}" publishes a package — an agent running "${name}" would release`,
      });
    }
    if (/^(pre|post)?install$/.test(name) && /\b(curl|wget)\b/.test(body)) {
      findings.push({
        severity: 'warn',
        file: 'package.json',
        message: `install hook "${name}" downloads from the network`,
      });
    }
  }
  const targets = [
    'Makefile',
    'justfile',
    ...ctx.files.filter((f) => /^[^/]+\.sh$/.test(f) || /^scripts\/[^/]+\.sh$/.test(f)),
  ];
  for (const f of targets) {
    const text = ctx.read(f);
    if (!text) continue;
    text.split('\n').forEach((line, i) => {
      if (/^\s*#/.test(line) || line.includes(SUPPRESS)) return;
      for (const rule of DANGER_RULES) {
        if (rule.why === 'uses sudo') continue; // common and intentional in setup scripts
        if (rule.re.test(line))
          findings.push({
            severity: 'warn',
            file: f,
            line: i + 1,
            message: `${rule.why}: \`${line.trim().slice(0, 80)}\``,
          });
      }
    });
  }
  return findings;
}

export const safetyChecks: Check[] = [
  {
    id: 'safety.secrets',
    category: 'safety',
    title: 'No secrets in the repo',
    weight: 3,
    async run(ctx): Promise<CheckResult> {
      const all = await scanSecrets(ctx);
      const findings = all.filter((f) => f.severity !== 'info');
      const dummies = all.length - findings.length;
      const errors = findings.filter((f) => f.severity === 'error').length;
      const warns = findings.length - errors;
      const score =
        findings.length === 0
          ? 1
          : errors === 0
            ? Math.max(0.5, 0.85 - 0.1 * (warns - 1))
            : Math.max(0, 0.5 - 0.25 * (errors - 1) - 0.05 * warns);
      const note = dummies ? ` (${dummies} test/example value(s) ignored)` : '';
      return {
        score,
        summary:
          findings.length === 0
            ? `No committed secrets or credential files found${note}`
            : `${findings.length} possible secret(s) visible to agents${note}`,
        findings: [...findings, ...all.filter((f) => f.severity === 'info')].slice(0, 20),
        suggestion: findings.length
          ? 'Remove the secret, rotate it, and add the file to .gitignore. Agents read and paste whatever they can see.'
          : undefined,
      };
    },
    // Agents that can see which env vars exist (but not their values) set up and run the app
    // instead of guessing or reading a real .env.
    fix: envExampleFix,
  },
  {
    id: 'safety.scripts',
    category: 'safety',
    title: 'No dangerous scripts',
    weight: 1,
    run(ctx): CheckResult {
      const findings = scanScripts(ctx);
      const score = Math.max(0, 1 - 0.34 * findings.length);
      return {
        score,
        summary:
          findings.length === 0
            ? 'Scripts look safe for agents to run'
            : `${findings.length} risky script command(s)`,
        findings: findings.slice(0, 20),
        suggestion: findings.length
          ? 'Agents run scripts liberally. Move destructive/publishing steps behind explicit, clearly named scripts (e.g. `release`).'
          : undefined,
      };
    },
  },
];
