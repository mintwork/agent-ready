import type { RepoContext } from '../context.js';
import type { FileChange } from '../types.js';
import { isAuxiliaryPath, isFixturePath } from '../util/paths.js';

/**
 * Generate `.env.example` from the environment variables the code reads. Only variable *names*
 * are ever written: values from a local `.env` are never read into the output, so the file is
 * safe to commit.
 */

/** Patterns that read one env var by literal name, per language. Group 1 is the name. */
const ENV_READS: Array<{ ext: RegExp; res: RegExp[] }> = [
  {
    ext: /\.(?:[cm]?[jt]sx?|vue|svelte|astro)$/,
    res: [
      /\bprocess\.env\.([A-Z][A-Z0-9_]*)\b/g,
      /\bprocess\.env\[\s*['"`]([A-Z][A-Z0-9_]*)['"`]\s*\]/g,
      /\bimport\.meta\.env\.([A-Z][A-Z0-9_]*)\b/g,
      /\b(?:Deno\.env\.get|Bun\.env\.get)\(\s*['"`]([A-Z][A-Z0-9_]*)['"`]/g,
      /\bBun\.env\.([A-Z][A-Z0-9_]*)\b/g,
    ],
  },
  {
    ext: /\.py$/,
    res: [
      /\bos\.environ\[\s*['"]([A-Z][A-Z0-9_]*)['"]\s*\]/g,
      /\b(?:os\.environ\.get|os\.getenv|environ\.get|getenv)\(\s*['"]([A-Z][A-Z0-9_]*)['"]/g,
    ],
  },
  { ext: /\.go$/, res: [/\bos\.(?:Getenv|LookupEnv)\(\s*"([A-Z][A-Z0-9_]*)"/g] },
  {
    ext: /\.rs$/,
    res: [/\b(?:env::var(?:_os)?|option_env!|env!)\(\s*"([A-Z][A-Z0-9_]*)"/g],
  },
  { ext: /\.rb$/, res: [/\bENV(?:\.fetch\(|\[)\s*['"]([A-Z][A-Z0-9_]*)['"]/g] },
];

/** Set by the OS, shell, CI or tooling: not project configuration. */
const SYSTEM_VARS = new Set([
  'PATH',
  'HOME',
  'USER',
  'USERNAME',
  'USERPROFILE',
  'SHELL',
  'PWD',
  'TERM',
  'TMPDIR',
  'TEMP',
  'TMP',
  'LANG',
  'LANGUAGE',
  'TZ',
  'EDITOR',
  'VISUAL',
  'HOSTNAME',
  'COLUMNS',
  'LINES',
  'CI',
  'NO_COLOR',
  'FORCE_COLOR',
  'NODE_ENV',
  'NODE_OPTIONS',
  'APPDATA',
  'LOCALAPPDATA',
  'PROGRAMFILES',
  'SYSTEMROOT',
  'COMSPEC',
  'MODE',
  'DEV',
  'PROD',
  'SSR',
  'BASE_URL',
  'FOO',
  'BAR',
  'BAZ',
  'QUX',
]);
const SYSTEM_PREFIX =
  /^(?:LC_|XDG_|GITHUB_|RUNNER_|npm_|NPM_CONFIG_|INIT_CWD|VITEST|JEST_|PYTEST_|CARGO_|RUSTUP_|GO(?:PATH|ROOT|OS|ARCH|FLAGS)|PYTHON|VIRTUAL_ENV|CONDA_|TERM_|WSL_)/;

/** Libraries that load a `.env` file: a strong sign `.env.example` is expected. */
const DOTENV_DEPS = ['dotenv', 'dotenv-flow', 'dotenv-cli', 'dotenv-expand', 'env-cmd', 'envalid'];
const DOTENV_PY = /python-dotenv|pydantic-settings|environs|django-environ/;
const DOTENV_IMPORT =
  /\bfrom\s+dotenv\s+import\b|\bimport\s+dotenv\b|\bjoho\/godotenv\b|\bdotenvy?::|require\(['"]dotenv['"]\)|from\s+['"]dotenv(?:\/config)?['"]/;

const LOCAL_DOTENV = ['.env', '.env.local', '.env.development', '.env.development.local'];

export const ENV_TEMPLATE =
  /(^|\/)(?:\.env(?:\.[\w-]+)*\.(?:example|sample|template|dist|defaults?)|example\.env|\.env\.(?:example|sample|template))$/;

function isSystemVar(name: string): boolean {
  return SYSTEM_VARS.has(name) || SYSTEM_PREFIX.test(name);
}

/** Keys (never values) of a dotenv file. */
export function dotenvKeys(text: string): string[] {
  const keys: string[] = [];
  for (const line of text.split(/\r?\n/)) {
    const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/.exec(line);
    if (m?.[1]) keys.push(m[1]);
  }
  return keys;
}

export interface EnvUsage {
  /** Variable name -> first product file that reads it. */
  vars: Map<string, string>;
  /** Whether the project loads `.env` files (dotenv, Vite, Next, pydantic-settings, ...). */
  loadsDotenv: boolean;
}

export function envUsage(ctx: RepoContext): EnvUsage {
  const vars = new Map<string, string>();
  let loadsDotenv = DOTENV_DEPS.some((d) => d in ctx.allDeps());
  if (!loadsDotenv) {
    const pyManifests = [ctx.pyproject ?? '', ctx.read('requirements.txt') ?? ''].join('\n');
    loadsDotenv = DOTENV_PY.test(pyManifests);
  }
  // Product code only: release scripts and CI helpers read CI-provided variables.
  const files = ctx.files
    .filter(
      (f) =>
        !isAuxiliaryPath(f) && !isFixturePath(f) && !/^(?:scripts|\.github|tools?|bin)\//.test(f),
    )
    .slice(0, 5000);
  for (const f of files) {
    const lang = ENV_READS.find((l) => l.ext.test(f));
    if (!lang) continue;
    const text = ctx.read(f);
    if (!text || text.length > 512 * 1024) continue;
    if (!loadsDotenv && DOTENV_IMPORT.test(text)) loadsDotenv = true;
    for (const re of lang.res) {
      for (const m of text.matchAll(re)) {
        const name = m[1] as string;
        if (!isSystemVar(name) && !vars.has(name)) vars.set(name, f);
      }
    }
  }
  return { vars, loadsDotenv };
}

/**
 * Propose `.env.example` when the project reads env vars from a `.env` file (a dotenv loader or a
 * local `.env` exists) and has no template yet. Names come from the code and from the keys of a
 * local `.env`; values are always left empty.
 */
export function envExampleFix(ctx: RepoContext): FileChange[] {
  if (ctx.files.some((f) => ENV_TEMPLATE.test(f)) || ctx.exists('.env.example')) return [];
  const { vars, loadsDotenv } = envUsage(ctx);
  const local = ctx.exists('.env') ? dotenvKeys(ctx.read('.env') ?? '') : [];
  // Frameworks such as Vite and Next also load .env files, but only matter once one exists.
  const anyDotenv = LOCAL_DOTENV.some((f) => ctx.exists(f));
  if (!loadsDotenv && !anyDotenv) return [];
  const byFile = new Map<string, string[]>();
  for (const [name, file] of vars) byFile.set(file, [...(byFile.get(file) ?? []), name]);
  const fromCode = new Set(vars.keys());
  const onlyLocal = [...new Set(local)].filter((k) => !fromCode.has(k) && !isSystemVar(k));
  if (fromCode.size + onlyLocal.length === 0) return [];
  const lines = [
    '# Environment variables for this project (generated by agent-ready from the code).',
    '# Copy to .env and fill in real values. Never commit .env.',
    '',
  ];
  for (const [file, names] of [...byFile].sort(([a], [b]) => a.localeCompare(b))) {
    lines.push(`# ${file}`, ...names.sort().map((n) => `${n}=`), '');
  }
  if (onlyLocal.length)
    lines.push('# Also set in your local .env', ...onlyLocal.map((n) => `${n}=`), '');
  return [
    {
      path: '.env.example',
      before: null,
      after: lines.join('\n'),
      kind: 'create',
      description: `Document ${fromCode.size + onlyLocal.length} environment variable(s) (names only, no values)`,
    },
  ];
}
