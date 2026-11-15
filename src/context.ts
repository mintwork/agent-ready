import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { open, readFile, stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import type { UserConfig } from './types.js';
import { Matcher, parseIgnoreFile } from './util/glob.js';
import { parseJsonc } from './util/jsonc.js';
import { isFixturePath } from './util/paths.js';

/** Directories that are always build output / dependency caches and never source. */
export const HEAVY_DIRS = [
  'node_modules',
  '.venv',
  'venv',
  '__pycache__',
  '.pytest_cache',
  '.mypy_cache',
  '.ruff_cache',
  '.tox',
  '.nox',
  '.next',
  '.nuxt',
  '.turbo',
  '.parcel-cache',
  '.svelte-kit',
  '.gradle',
] as const;

const MAX_FILES = 200_000;

export type Language = 'typescript' | 'javascript' | 'python' | 'go' | 'rust';

export type PackageManager = 'npm' | 'pnpm' | 'yarn' | 'bun';

export interface PackageJson {
  name?: string;
  description?: string;
  scripts?: Record<string, string>;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  workspaces?: unknown;
  packageManager?: string;
  eslintConfig?: unknown;
  'agent-ready'?: UserConfig;
  [key: string]: unknown;
}

export interface RepoContext {
  root: string;
  isGit: boolean;
  /**
   * For a workspace package scanned on its own (see `createPackageContext`): the repository
   * context it was derived from, and the package directory relative to the repository root.
   */
  parent?: { ctx: RepoContext; dir: string };
  /** Files an agent would see (respects .gitignore / .ignore), posix relative paths. */
  files: string[];
  /** Tracked files that live inside dependency/cache dirs (should never be committed). */
  trackedHeavy: string[];
  truncated: boolean;
  /** Milliseconds spent building this context (listing files, reading manifests). */
  setupMs: number;
  languages: Language[];
  /** Number of (non-fixture, non-vendored) code files per detected language. */
  codeFiles: Partial<Record<Language, number>>;
  /**
   * Share (0..1) of the detected languages' code written in the given language(s). Used to weight
   * per-language checks so a tooling package.json doesn't count as much as the main language.
   */
  share(...langs: Language[]): number;
  pkg: PackageJson | null;
  pyproject: string | null;
  packageManager: PackageManager;
  config: UserConfig;
  /** True if the path (file or dir) exists on disk. */
  exists(rel: string): boolean;
  /** True if the path is in the agent-visible file list. */
  has(rel: string): boolean;
  read(rel: string): string | null;
  readJson<T = unknown>(rel: string): T | null;
  size(rel: string): number;
  lineCount(rel: string): number;
  /** Whether a path is ignored by git (or the .gitignore matcher when not a git repo). */
  isIgnored(rel: string): boolean;
  /** Batch version of `isIgnored` (one git call); results are cached for later `isIgnored` calls. */
  isIgnoredMany(rels: string[]): Map<string, boolean>;
  /** Whether git tracks at least one file under this directory. */
  hasTracked(relDir: string): boolean;
  /** Visible files with one of the given extensions. */
  filesWithExt(...exts: string[]): string[];
  scripts(): Record<string, string>;
  allDeps(): Record<string, string>;
  /** Stat every visible file concurrently so later `size()` calls are cache hits. */
  prefetchSizes(): Promise<void>;
  /**
   * Read many files concurrently (without caching their text) and map each to a small result.
   * Files that are missing, larger than `maxBytes` or binary map to `null`. Results keep input order.
   */
  mapFiles<T>(
    paths: string[],
    fn: (rel: string, text: string) => T,
    maxBytes?: number,
  ): Promise<Array<T | null>>;
}

const IO_CONCURRENCY = 32;

async function pool<T>(
  items: T[],
  worker: (item: T, index: number) => Promise<void>,
): Promise<void> {
  let next = 0;
  const run = async () => {
    while (next < items.length) {
      const i = next++;
      await worker(items[i] as T, i);
    }
  };
  await Promise.all(Array.from({ length: Math.min(IO_CONCURRENCY, items.length) }, run));
}

function git(root: string, args: string[], input?: string): string | null {
  try {
    return execFileSync('git', args, {
      cwd: root,
      encoding: 'utf8',
      input,
      maxBuffer: 256 * 1024 * 1024,
      stdio: ['pipe', 'pipe', 'ignore'],
    });
  } catch (err) {
    const e = err as { status?: number; stdout?: string };
    // check-ignore exits 1 when nothing matched; stdout is still meaningful.
    if (e.status === 1 && typeof e.stdout === 'string') return e.stdout;
    return null;
  }
}

function splitZ(out: string | null): string[] {
  if (!out) return [];
  return out.split('\0').filter(Boolean);
}

function isHeavyPath(p: string): boolean {
  const parts = p.split('/');
  parts.pop();
  return parts.some((seg) => (HEAVY_DIRS as readonly string[]).includes(seg));
}

function walk(root: string, ignore: Matcher, out: string[], dir = ''): void {
  if (out.length >= MAX_FILES) return;
  let entries: import('node:fs').Dirent[];
  try {
    entries = readdirSync(join(root, dir), { withFileTypes: true });
  } catch {
    return;
  }
  for (const ent of entries) {
    const rel = dir ? `${dir}/${ent.name}` : ent.name;
    if (ent.isDirectory()) {
      if (ent.name === '.git' || (HEAVY_DIRS as readonly string[]).includes(ent.name)) continue;
      if (ignore.matches(`${rel}/x`)) continue;
      walk(root, ignore, out, rel);
    } else if (ent.isFile()) {
      if (!ignore.matches(rel)) out.push(rel);
    }
    if (out.length >= MAX_FILES) return;
  }
}

function detectPackageManager(root: string, pkg: PackageJson | null): PackageManager {
  const pm = pkg?.packageManager?.split('@')[0];
  if (pm === 'pnpm' || pm === 'yarn' || pm === 'bun' || pm === 'npm') return pm;
  if (existsSync(join(root, 'pnpm-lock.yaml'))) return 'pnpm';
  if (existsSync(join(root, 'yarn.lock'))) return 'yarn';
  if (existsSync(join(root, 'bun.lockb')) || existsSync(join(root, 'bun.lock'))) return 'bun';
  return 'npm';
}

export function loadConfig(root: string, pkg: PackageJson | null): UserConfig {
  for (const name of ['agent-ready.config.json', '.agent-ready.json']) {
    const p = join(root, name);
    if (existsSync(p)) {
      const parsed = parseJsonc(readFileSync(p, 'utf8'));
      if (parsed && typeof parsed === 'object') return parsed as UserConfig;
    }
  }
  return pkg?.['agent-ready'] ?? {};
}

export function createContext(rootInput: string): RepoContext {
  const t0 = Date.now();
  const root = resolve(rootInput);
  if (!existsSync(root) || !statSync(root).isDirectory()) {
    throw new Error(`Not a directory: ${root}`);
  }
  const read = makeReader(root, new Map());
  const pkg = parsePkg(read('package.json'));
  const config = loadConfig(root, pkg);

  const gitDir = git(root, ['rev-parse', '--is-inside-work-tree']);
  const isGit = gitDir?.trim() === 'true';

  const gitignore = new Matcher(parseIgnoreFile(read('.gitignore') ?? ''));
  // ripgrep (used by Claude Code and Codex) and Cursor also honor these files.
  const agentIgnore = new Matcher([
    ...parseIgnoreFile(read('.ignore') ?? ''),
    ...parseIgnoreFile(read('.rgignore') ?? ''),
    ...parseIgnoreFile(read('.cursorignore') ?? ''),
    ...(config.ignore ?? []),
  ]);

  let files: string[] = [];
  let tracked = new Set<string>();
  const trackedHeavy: string[] = [];

  if (isGit) {
    const trackedList = splitZ(git(root, ['ls-files', '-c', '-z', '--', '.']));
    tracked = new Set(trackedList);
    const excludes = HEAVY_DIRS.map((d) => `:(exclude,glob)**/${d}/**`);
    const untracked = splitZ(
      git(root, ['ls-files', '-o', '--exclude-standard', '-z', '--', '.', ...excludes]),
    );
    for (const f of trackedList) {
      if (isHeavyPath(f)) trackedHeavy.push(f);
      else files.push(f);
    }
    files.push(...untracked);
  } else {
    walk(root, gitignore, files);
  }

  if (agentIgnore.size > 0) files = files.filter((f) => !agentIgnore.matches(f));
  // git ls-files -c lists deleted-but-unstaged files; drop them lazily on read.
  const truncated = files.length > MAX_FILES;
  if (truncated) files = files.slice(0, MAX_FILES);
  files.sort();

  const ignoredCache = new Map<string, boolean>();
  const isIgnored = (rel: string): boolean => {
    const cached = ignoredCache.get(rel);
    if (cached !== undefined) return cached;
    let ignored: boolean;
    if (isGit) {
      const out = git(root, ['check-ignore', '--no-index', '--stdin'], `${rel}\n${rel}/x\n`);
      ignored = Boolean(out?.trim());
    } else {
      ignored = gitignore.matches(rel) || gitignore.matches(`${rel}/x`);
    }
    ignoredCache.set(rel, ignored);
    return ignored;
  };

  const isIgnoredMany = (rels: string[]): Map<string, boolean> => {
    const todo = [...new Set(rels)].filter((r) => !ignoredCache.has(r) && !r.includes('\n'));
    if (todo.length && isGit) {
      const out = git(
        root,
        ['check-ignore', '--no-index', '--stdin'],
        `${todo.flatMap((r) => [r, `${r}/x`]).join('\n')}\n`,
      );
      const hit = new Set((out ?? '').split('\n').filter(Boolean));
      for (const r of todo) ignoredCache.set(r, hit.has(r) || hit.has(`${r}/x`));
    }
    return new Map(rels.map((r) => [r, isIgnored(r)]));
  };

  const hasTracked = (relDir: string): boolean => {
    const prefix = `${relDir.replace(/\/$/, '')}/`;
    for (const f of tracked) if (f.startsWith(prefix)) return true;
    return false;
  };

  return buildContext({
    t0,
    root,
    read,
    pkg,
    config,
    isGit,
    files,
    trackedHeavy,
    truncated,
    isIgnored,
    isIgnoredMany,
    hasTracked,
    overlay: new Map(),
  });
}

/**
 * Repo-root files that still apply inside a workspace package that has none of its own: linter and
 * TypeScript configs (tools look them up from parent directories), .gitignore and CI workflows.
 */
const INHERITED = [
  /^\.gitignore$/,
  /^tsconfig\.json$/,
  /^biome\.jsonc?$/,
  /^(?:eslint\.config\.[cm]?[jt]s|\.eslintrc(?:\.\w+)?)$/,
  /^\.oxlintrc\.json$/,
  /^\.prettierrc/,
  /^\.?ruff\.toml$/,
  /^(?:\.flake8|\.pylintrc|mypy\.ini|pyrightconfig\.json)$/,
  /^\.?clippy\.toml$/,
  /^\.golangci\.(?:ya?ml|toml|json)$/,
  /^\.github\/workflows\/[^/]+\.ya?ml$/,
  /^\.gitlab-ci\.yml$/,
];

/** Root scripts run from the repo root on behalf of every package (not lifecycle hooks). */
const LIFECYCLE_SCRIPT = /^(?:pre|post)|^(?:prepare|install|prepublishOnly|prepack)$/;

/**
 * A context for one workspace package (`dir`, relative to the parent's root), derived from the
 * parent without listing files again. `exclude` removes nested packages (used for the root package
 * of a repo whose root is itself a crate/module). Inherited root configs are visible under their
 * root-relative names when the package has no file of that name.
 */
export function createPackageContext(
  parent: RepoContext,
  dir: string,
  exclude: string[] = [],
): RepoContext {
  const t0 = Date.now();
  const clean = dir.replace(/^\.\/?|\/$/g, '');
  const prefix = clean ? `${clean}/` : '';
  const root = clean ? join(parent.root, clean) : parent.root;
  const excluded = exclude
    .map((d) => d.replace(/^\.\/?|\/$/g, ''))
    .filter((d) => d && d !== clean)
    .map((d) => `${d}/`);
  const under = (f: string) => f.startsWith(prefix) && !excluded.some((e) => f.startsWith(e));
  const files = parent.files.filter(under).map((f) => f.slice(prefix.length));
  const own = new Set(files);
  const overlay = new Map<string, string>();
  if (prefix) {
    for (const f of parent.files) {
      if (!f.includes('/') || f.startsWith('.github/')) {
        if (!own.has(f) && INHERITED.some((re) => re.test(f))) overlay.set(f, join(parent.root, f));
      }
    }
  }
  files.push(...overlay.keys());
  files.sort();
  const read = makeReader(root, overlay);
  const pkg = parsePkg(read('package.json'));
  const up = (rel: string) => `${prefix}${rel}`;
  return buildContext({
    t0,
    root,
    read,
    pkg,
    config: parent.config,
    isGit: parent.isGit,
    files,
    trackedHeavy: parent.trackedHeavy.filter(under).map((f) => f.slice(prefix.length)),
    truncated: parent.truncated,
    isIgnored: (rel) => parent.isIgnored(up(rel)),
    isIgnoredMany: (rels) => {
      const res = parent.isIgnoredMany(rels.map(up));
      return new Map(rels.map((r) => [r, res.get(up(r)) ?? false]));
    },
    hasTracked: (relDir) => parent.hasTracked(up(relDir)),
    overlay,
    // Root scripts (`test`, `lint`, `typecheck`) and hoisted dev tools cover JS packages without their own.
    ...(prefix && pkg
      ? {
          inheritedScripts: Object.fromEntries(
            Object.entries(parent.pkg?.scripts ?? {}).filter(([k]) => !LIFECYCLE_SCRIPT.test(k)),
          ),
          inheritedDeps: parent.allDeps(),
        }
      : {}),
    parent: { ctx: parent, dir: clean || '.' },
  });
}

function parsePkg(text: string | null): PackageJson | null {
  if (!text) return null;
  const parsed = parseJsonc(text);
  return parsed && typeof parsed === 'object' ? (parsed as PackageJson) : null;
}

function makeReader(root: string, overlay: Map<string, string>) {
  const readCache = new Map<string, string | null>();
  const read = (rel: string): string | null => {
    if (readCache.has(rel)) return readCache.get(rel) ?? null;
    let content: string | null = null;
    try {
      content = readFileSync(overlay.get(rel) ?? join(root, rel), 'utf8');
    } catch {
      content = null;
    }
    readCache.set(rel, content);
    return content;
  };
  return Object.assign(read, { cache: readCache });
}

interface ContextParts {
  t0: number;
  root: string;
  read: ReturnType<typeof makeReader>;
  pkg: PackageJson | null;
  config: UserConfig;
  isGit: boolean;
  files: string[];
  trackedHeavy: string[];
  truncated: boolean;
  isIgnored(rel: string): boolean;
  isIgnoredMany(rels: string[]): Map<string, boolean>;
  hasTracked(relDir: string): boolean;
  /** Repo-relative name -> absolute path, for files inherited from a parent directory. */
  overlay: Map<string, string>;
  /** Root package.json scripts / dependencies a workspace package can use (hoisted tooling). */
  inheritedScripts?: Record<string, string>;
  inheritedDeps?: Record<string, string>;
  parent?: RepoContext['parent'];
}

function buildContext(parts: ContextParts): RepoContext {
  const { t0, root, read, pkg, config, isGit, files, overlay } = parts;
  const readCache = read.cache;
  const abs = (rel: string) => overlay.get(rel) ?? join(root, rel);
  const fileSet = new Set(files);

  const statCache = new Map<string, number>();
  const size = (rel: string): number => {
    const cached = statCache.get(rel);
    if (cached !== undefined) return cached;
    let s = -1;
    try {
      s = statSync(abs(rel)).size;
    } catch {
      s = -1;
    }
    statCache.set(rel, s);
    return s;
  };

  const lineCache = new Map<string, number>();
  const lineCount = (rel: string): number => {
    const cached = lineCache.get(rel);
    if (cached !== undefined) return cached;
    const text = read(rel);
    let n = 0;
    if (text) {
      for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) === 10) n++;
      if (text.length > 0 && text[text.length - 1] !== '\n') n++;
    }
    lineCache.set(rel, n);
    return n;
  };

  const filesWithExt = (...exts: string[]): string[] =>
    files.filter((f) => exts.some((e) => f.endsWith(e)));

  const pyproject = read('pyproject.toml');
  // A language counts if it has a manifest, or makes up a meaningful share of the code
  // (a couple of helper scripts don't make a JS repo a Python project). Fixtures and vendored
  // code don't count towards the share.
  const counted = files.filter(
    (f) => !isFixturePath(f) && !/(^|\/)(vendor|third[-_]party)\//.test(f),
  );
  const countExt = (re: RegExp) => counted.filter((f) => re.test(f)).length;
  const tsCount = countExt(/\.(?:ts|tsx|mts|cts)$/) - countExt(/\.d\.ts$/);
  const jsCount = countExt(/\.(?:js|jsx|mjs|cjs)$/);
  const pyCount = countExt(/\.py$/);
  const goCount = countExt(/\.go$/);
  const rsCount = countExt(/\.rs$/);
  const otherCount = countExt(/\.(?:java|kt|scala|c|cc|cpp|h|hpp|cs|rb|php|swift|m|zig|ex|exs)$/);
  const codeTotal = tsCount + jsCount + pyCount + goCount + rsCount + otherCount;
  const significant = (n: number) =>
    n > 0 && (n >= Math.max(3, codeTotal * 0.1) || n === codeTotal);
  const hasTsconfig = files.some(
    (f) => /(^|\/)tsconfig(\.[\w-]+)?\.json$/.test(f) && !isFixturePath(f),
  );
  const pyManifest =
    pyproject !== null ||
    fileSet.has('setup.py') ||
    fileSet.has('requirements.txt') ||
    fileSet.has('Pipfile');
  const languages: Language[] = [];
  if (hasTsconfig || significant(tsCount)) languages.push('typescript');
  if (significant(jsCount) || (pkg && !languages.includes('typescript'))) {
    languages.push('javascript');
  }
  if (pyManifest || significant(pyCount)) languages.push('python');
  if (fileSet.has('go.mod') || significant(goCount)) languages.push('go');
  if (fileSet.has('Cargo.toml') || significant(rsCount)) languages.push('rust');
  const codeFiles: Partial<Record<Language, number>> = {};
  const counts: Record<Language, number> = {
    typescript: tsCount,
    javascript: jsCount,
    python: pyCount,
    go: goCount,
    rust: rsCount,
  };
  for (const l of languages) codeFiles[l] = counts[l];
  const detectedTotal = languages.reduce((n, l) => n + counts[l], 0);
  const share = (...langs: Language[]): number => {
    const present = langs.filter((l) => languages.includes(l));
    if (present.length === 0) return 0;
    if (detectedTotal === 0) return present.length / languages.length;
    return present.reduce((n, l) => n + counts[l], 0) / detectedTotal;
  };

  return {
    root,
    isGit,
    ...(parts.parent ? { parent: parts.parent } : {}),
    files,
    trackedHeavy: parts.trackedHeavy,
    truncated: parts.truncated,
    setupMs: Date.now() - t0,
    languages,
    codeFiles,
    share,
    pkg,
    pyproject,
    packageManager: parts.parent?.ctx.packageManager ?? detectPackageManager(root, pkg),
    config,
    exists: (rel) => overlay.has(rel) || existsSync(join(root, rel)),
    has: (rel) => fileSet.has(rel),
    read,
    readJson<T>(rel: string): T | null {
      const text = read(rel);
      return text === null ? null : (parseJsonc(text) as T | null);
    },
    size,
    lineCount,
    isIgnored: parts.isIgnored,
    isIgnoredMany: parts.isIgnoredMany,
    hasTracked: parts.hasTracked,
    filesWithExt,
    async prefetchSizes() {
      const todo = files.filter((f) => !statCache.has(f));
      await pool(todo, async (f) => {
        try {
          statCache.set(f, (await stat(abs(f))).size);
        } catch {
          statCache.set(f, -1);
        }
      });
    },
    async mapFiles<T>(
      paths: string[],
      fn: (rel: string, text: string) => T,
      maxBytes = 512 * 1024,
    ): Promise<Array<T | null>> {
      const out: Array<T | null> = new Array(paths.length).fill(null);
      await pool(paths, async (f, i) => {
        const cachedText = readCache.get(f);
        if (cachedText !== undefined) {
          if (cachedText !== null && !cachedText.includes('\0')) out[i] = fn(f, cachedText);
          return;
        }
        const known = statCache.get(f);
        if (known !== undefined && (known <= 0 || known > maxBytes)) return;
        let text: string | null = null;
        if (known !== undefined) {
          try {
            text = await readFile(abs(f), 'utf8');
          } catch {
            text = null;
          }
          if (text !== null && !text.includes('\0')) out[i] = fn(f, text);
          return;
        }
        try {
          const fh = await open(abs(f), 'r');
          try {
            const sz = known ?? (await fh.stat()).size;
            statCache.set(f, sz);
            if (sz > 0 && sz <= maxBytes) text = (await fh.readFile()).toString('utf8');
          } finally {
            await fh.close();
          }
        } catch {
          text = null;
        }
        if (text !== null && !text.includes('\0')) out[i] = fn(f, text);
      });
      return out;
    },
    scripts: () => ({ ...parts.inheritedScripts, ...(pkg?.scripts ?? {}) }),
    allDeps: () => ({
      ...parts.inheritedDeps,
      ...(pkg?.dependencies ?? {}),
      ...(pkg?.devDependencies ?? {}),
    }),
  };
}

/** Command to run a package.json script with the detected package manager. */
export function runScriptCmd(ctx: RepoContext, script: string): string {
  const pm = ctx.packageManager;
  if (script === 'test' && pm !== 'bun') return `${pm} test`;
  if (pm === 'npm') return `npm run ${script}`;
  return `${pm} ${pm === 'bun' ? 'run ' : ''}${script}`;
}
