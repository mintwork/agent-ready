import { posix } from 'node:path';
import type { RepoContext } from './context.js';
import { isAuxiliaryPath, isFixturePath } from './util/paths.js';

export type WorkspaceKind = 'npm' | 'pnpm' | 'yarn' | 'bun' | 'cargo' | 'go';

export interface WorkspacePackage {
  /** Directory relative to the repo root (`.` for a repo whose root is itself a package). */
  dir: string;
  /** Package / crate / module name, when the manifest has one. */
  name: string | null;
  kind: WorkspaceKind;
}

export interface Workspaces {
  /** Workspace tools that declared packages, e.g. `['pnpm']` or `['cargo', 'npm']`. */
  kinds: WorkspaceKind[];
  packages: WorkspacePackage[];
}

/** Workspace glob (`packages/*`, `apps/**`, `crates/foo`) to a regex over directory paths. */
export function workspaceGlobRe(glob: string): RegExp {
  const g = trimSlashes(glob.trim().replace(/^\.\//, ''));
  let re = '';
  for (let i = 0; i < g.length; i++) {
    const ch = g[i] as string;
    if (ch === '*') {
      if (g[i + 1] === '*') {
        re += '.*';
        i++;
        if (g[i + 1] === '/') i++;
      } else re += '[^/]*';
    } else if (ch === '?') re += '[^/]';
    else re += /[.+^${}()|[\]\\]/.test(ch) ? `\\${ch}` : ch;
  }
  return new RegExp(`^${re}$`);
}

/** Expand workspace globs (with `!negations`) against directories that contain a manifest. */
function expand(globs: string[], dirs: string[]): string[] {
  const include = globs.filter((g) => !g.startsWith('!')).map(workspaceGlobRe);
  const exclude = globs.filter((g) => g.startsWith('!')).map((g) => workspaceGlobRe(g.slice(1)));
  return dirs.filter(
    (d) => d !== '.' && include.some((re) => re.test(d)) && !exclude.some((re) => re.test(d)),
  );
}

/** Items of a top-level YAML list (`packages:` in pnpm-workspace.yaml). Enough for real files. */
export function yamlList(text: string, key: string): string[] {
  const out: string[] = [];
  let inside = false;
  for (const raw of text.split(/\r?\n/)) {
    const hash = raw.search(/\s#/);
    const line = hash === -1 ? raw : raw.slice(0, hash);
    if (!line.trim()) continue;
    if (/^\S/.test(line)) {
      inside = new RegExp(`^${key}\\s*:\\s*(\\[.*\\])?\\s*$`).test(line);
      const inline = /\[(.*)\]/.exec(line);
      if (inside && inline) {
        out.push(...(inline[1] ?? '').split(',').map(unquote).filter(Boolean));
        inside = false;
      }
      continue;
    }
    const m = inside ? /^\s+-\s*(.+?)\s*$/.exec(line) : null;
    if (m) out.push(unquote(m[1] ?? ''));
  }
  return out.filter(Boolean);
}

/** Drop trailing slashes (a loop, not a regex: `/\/+$/` backtracks on long runs of slashes). */
function trimSlashes(s: string): string {
  let end = s.length;
  while (end > 0 && s[end - 1] === '/') end--;
  return s.slice(0, end);
}

function unquote(s: string): string {
  return s.trim().replace(/^['"]|['"]$/g, '');
}

/** A TOML array value (`members = [ "a", "b/*" ]`, possibly multi-line) inside a `[section]`. */
export function tomlArray(text: string, section: string, key: string): string[] | null {
  const lines = text.split(/\r?\n/);
  let inSection = false;
  for (let i = 0; i < lines.length; i++) {
    const line = (lines[i] ?? '').trim();
    if (/^\[/.test(line)) {
      inSection = line === `[${section}]`;
      continue;
    }
    if (!inSection) continue;
    const m = new RegExp(`^${key}\\s*=\\s*\\[(.*)$`).exec(line);
    if (!m) continue;
    let buf = m[1] ?? '';
    while (!buf.includes(']') && i + 1 < lines.length) buf += `\n${lines[++i] ?? ''}`;
    const inner = buf.slice(0, buf.indexOf(']')).replace(/#[^\n]*/g, '');
    return [...inner.matchAll(/["']([^"']+)["']/g)].map((x) => x[1] as string);
  }
  return null;
}

/** `use ./a` / `use ( ./a ./b )` directives in a go.work file. */
export function goWorkUses(text: string): string[] {
  const out: string[] = [];
  const noComments = text.replace(/\/\/[^\n]*/g, '');
  for (const m of noComments.matchAll(/^\s*use\s*\(([\s\S]*?)\)/gm)) {
    out.push(...(m[1] ?? '').split(/\s+/).filter(Boolean));
  }
  for (const m of noComments.matchAll(/^\s*use\s+([^\s(][^\s]*)/gm)) out.push(m[1] ?? '');
  return out.map((u) => trimSlashes(unquote(u).replace(/^\.\//, '')) || '.');
}

function manifestDirs(ctx: RepoContext, name: string): string[] {
  return ctx.files
    .filter((f) => (f === name || f.endsWith(`/${name}`)) && !isFixturePath(f))
    .map((f) => posix.dirname(f));
}

const cache = new WeakMap<RepoContext, Workspaces | null>();

/**
 * Workspace packages declared by npm/yarn/bun (`workspaces` in package.json), pnpm
 * (`pnpm-workspace.yaml`), Cargo (`[workspace] members`) and Go (`go.work`, or several `go.mod`
 * modules). Returns null for a single-package repo.
 */
export function detectWorkspaces(ctx: RepoContext): Workspaces | null {
  if (cache.has(ctx)) return cache.get(ctx) ?? null;
  const byDir = new Map<string, WorkspacePackage>();
  const kinds: WorkspaceKind[] = [];
  const add = (kind: WorkspaceKind, dirs: string[], nameOf: (dir: string) => string | null) => {
    let added = false;
    for (const dir of dirs) {
      if (byDir.has(dir)) continue;
      byDir.set(dir, { dir, kind, name: nameOf(dir) });
      added = true;
    }
    if (added && !kinds.includes(kind)) kinds.push(kind);
  };

  // JavaScript
  const pkgDirs = manifestDirs(ctx, 'package.json');
  const jsName = (d: string) => ctx.readJson<{ name?: unknown }>(`${d}/package.json`)?.name;
  const jsNameOf = (d: string) => {
    const n = jsName(d);
    return typeof n === 'string' ? n : null;
  };
  const pnpm = ctx.read('pnpm-workspace.yaml');
  if (pnpm !== null) add('pnpm', expand(yamlList(pnpm, 'packages'), pkgDirs), jsNameOf);
  const ws = ctx.pkg?.workspaces;
  const globs = Array.isArray(ws)
    ? ws
    : ws && typeof ws === 'object' && Array.isArray((ws as { packages?: unknown }).packages)
      ? (ws as { packages: unknown[] }).packages
      : [];
  if (globs.length) {
    const pm = ctx.packageManager;
    const kind: WorkspaceKind = pm === 'yarn' || pm === 'bun' ? pm : 'npm';
    add(
      kind,
      expand(
        globs.filter((g): g is string => typeof g === 'string'),
        pkgDirs,
      ),
      jsNameOf,
    );
  }

  // Rust
  const cargo = ctx.read('Cargo.toml');
  const members = cargo === null ? null : tomlArray(cargo, 'workspace', 'members');
  if (cargo !== null && members) {
    const exclude = tomlArray(cargo, 'workspace', 'exclude') ?? [];
    const crateName = (d: string) => {
      const toml = ctx.read(d === '.' ? 'Cargo.toml' : `${d}/Cargo.toml`) ?? '';
      return /^\[package\][^[]*?^name\s*=\s*["']([^"']+)["']/ms.exec(toml)?.[1] ?? null;
    };
    const dirs = expand(
      [...members, ...exclude.map((e) => `!${e}`)],
      manifestDirs(ctx, 'Cargo.toml'),
    );
    add('cargo', dirs, crateName);
  }

  // Go
  const goName = (d: string) =>
    /^module\s+(\S+)/m.exec(ctx.read(d === '.' ? 'go.mod' : `${d}/go.mod`) ?? '')?.[1] ?? null;
  const goWork = ctx.read('go.work');
  if (goWork !== null) {
    const mods = new Set(manifestDirs(ctx, 'go.mod'));
    add(
      'go',
      goWorkUses(goWork).filter((d) => d !== '.' && mods.has(d)),
      goName,
    );
  } else {
    // Multi-module repo without go.work: every product go.mod below the root is a module.
    const mods = manifestDirs(ctx, 'go.mod').filter((d) => d !== '.' && !isAuxiliaryPath(`${d}/x`));
    if (mods.length) add('go', mods, goName);
  }

  // Examples, test helpers and docs sites are workspace members but not the product.
  for (const dir of [...byDir.keys()]) if (isAuxiliaryPath(`${dir}/x`)) byDir.delete(dir);
  if (byDir.size === 0) {
    cache.set(ctx, null);
    return null;
  }
  // A root that is itself a crate / module / package with real code is a package too.
  const nested = [...byDir.keys()];
  const rootCode = ctx.files.filter(
    (f) =>
      CODE_EXT.test(f) &&
      !nested.some((d) => f.startsWith(`${d}/`)) &&
      !isAuxiliaryPath(f) &&
      !/^(?:scripts|tools?|\.github)\//.test(f),
  ).length;
  const packages = [...byDir.values()].sort((a, b) => a.dir.localeCompare(b.dir));
  if (rootCode >= MIN_PACKAGE_CODE_FILES) {
    const kind = cargo && /^\[package\]/m.test(cargo) ? 'cargo' : ctx.has('go.mod') ? 'go' : null;
    packages.unshift({
      dir: '.',
      kind: kind ?? kinds[0] ?? 'npm',
      name:
        kind === 'cargo'
          ? (/^\[package\][^[]*?^name\s*=\s*["']([^"']+)["']/ms.exec(cargo ?? '')?.[1] ?? null)
          : kind === 'go'
            ? goName('.')
            : (ctx.pkg?.name ?? null),
    });
  }
  const result: Workspaces = { kinds, packages };
  cache.set(ctx, result);
  return result;
}

export const CODE_EXT = /\.(?:[cm]?[jt]sx?|py|go|rs|java|kt|vue|svelte)$/;

/** Packages with fewer code files than this are too small to need their own docs. */
export const MIN_PACKAGE_CODE_FILES = 10;

/** Code files (excluding tests, fixtures, examples, docs) in a package directory. */
export function packageCodeFiles(ctx: RepoContext, ws: Workspaces, pkg: WorkspacePackage): number {
  const others = ws.packages
    .map((p) => p.dir)
    .filter((d) => d !== '.' && d !== pkg.dir && (pkg.dir === '.' || d.startsWith(`${pkg.dir}/`)));
  const prefix = pkg.dir === '.' ? '' : `${pkg.dir}/`;
  let n = 0;
  for (const f of ctx.files) {
    if (!f.startsWith(prefix) || !CODE_EXT.test(f)) continue;
    if (others.some((d) => f.startsWith(`${d}/`))) continue;
    if (isAuxiliaryPath(f.slice(prefix.length))) continue;
    n++;
  }
  return n;
}
