import { posix } from 'node:path';
import type { RepoContext } from '../context.js';
import type { Check, CheckResult, Finding } from '../types.js';
import { isAuxiliaryPath, isFixturePath } from '../util/paths.js';

/**
 * Deeper Go and Rust checks: how much of the code opts out of the type system (`interface{}`/`any`
 * in Go, `unsafe` in Rust), and whether one `cargo` invocation reaches every crate.
 */

/** Go/Rust product code: no tests, fixtures, examples, vendored or generated files. */
function productFiles(ctx: RepoContext, ext: string): string[] {
  return ctx.files.filter(
    (f) =>
      f.endsWith(ext) &&
      !isAuxiliaryPath(f) &&
      !isFixturePath(f) &&
      !/(^|\/)(vendor|third[-_]party|target|benches|fuzz)\//.test(f) &&
      !/_test\.go$|\.pb\.go$|_gen\.go$|\.gen\.go$|zz_generated/.test(f),
  );
}

/** Remove comments and string literals so `"any"` or `// interface{}` don't count. */
function stripGo(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/\/\/[^\n]*/g, '')
    .replace(/`[^`]*`/g, '""')
    .replace(/"(?:[^"\\\n]|\\.)*"/g, '""')
    .replace(/'(?:[^'\\\n]|\\.)*'/g, "''");
}

/**
 * `interface{}` and `any` used as a type. Type-parameter constraints (`[T any]`, `[K comparable, V
 * any]`) are idiomatic generics and are not counted.
 */
export function goAnyCount(src: string): number {
  const code = stripGo(src);
  const empty = (code.match(/\binterface\s*\{\s*\}/g) ?? []).length;
  let anys = 0;
  for (const m of code.matchAll(/\bany\b/g)) {
    const before = code.slice(Math.max(0, (m.index ?? 0) - 40), m.index);
    const after = code.slice((m.index ?? 0) + 3, (m.index ?? 0) + 4);
    // `[T any]`, `[T any, U comparable]`, `[K comparable, V any]`, `[K, V any]`
    if (/[[,]\s*[A-Z]\w*\s+$/.test(before) && /[\],]/.test(after)) continue;
    anys++;
  }
  return empty + anys;
}

/** `unsafe { }` blocks, `unsafe fn`, `unsafe impl` and `unsafe trait` in Rust source. */
export function rustUnsafeCount(src: string): number {
  const code = src
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/\/\/[^\n]*/g, '')
    .replace(/"(?:[^"\\\n]|\\.)*"/g, '""');
  return (code.match(/\bunsafe\s*(?:\{|fn\b|impl\b|trait\b|extern\b)/g) ?? []).length;
}

function nonBlankLines(src: string): number {
  let n = 0;
  for (const line of src.split('\n')) if (line.trim()) n++;
  return n;
}

/** Linear score: 1 at or below `ok` per KLOC, down to `floor` at `bad` per KLOC and beyond. */
function densityScore(perKloc: number, ok: number, bad: number, floor = 0.6): number {
  if (perKloc <= ok) return 1;
  if (perKloc >= bad) return floor;
  return 1 - ((perKloc - ok) / (bad - ok)) * (1 - floor);
}

interface Density {
  total: number;
  lines: number;
  perKloc: number;
  top: Array<{ file: string; count: number }>;
}

async function density(
  ctx: RepoContext,
  files: string[],
  count: (src: string) => number,
): Promise<Density> {
  const per = await ctx.mapFiles(files.slice(0, 5000), (file, text) => ({
    file,
    count: count(text),
    lines: nonBlankLines(text),
  }));
  let total = 0;
  let lines = 0;
  const top: Array<{ file: string; count: number }> = [];
  for (const p of per) {
    if (!p) continue;
    total += p.count;
    lines += p.lines;
    if (p.count) top.push({ file: p.file, count: p.count });
  }
  top.sort((a, b) => b.count - a.count || a.file.localeCompare(b.file));
  return { total, lines, perKloc: lines ? (total / lines) * 1000 : 0, top: top.slice(0, 5) };
}

const goAnyCheck: Check = {
  id: 'types.go-any',
  category: 'types',
  title: 'Go code avoids interface{} / any',
  weight: 1,
  async run(ctx): Promise<CheckResult> {
    if (!ctx.languages.includes('go')) return { score: null, summary: 'No Go' };
    const files = productFiles(ctx, '.go');
    if (files.length === 0) return { score: null, summary: 'No Go product code' };
    const d = await density(ctx, files, goAnyCount);
    const score = densityScore(d.perKloc, 2, 30, 0.7);
    return {
      score,
      weightScale: ctx.share('go'),
      summary: `${d.total} interface{}/any in ${Math.round(d.lines / 100) / 10}k lines of Go (${d.perKloc.toFixed(1)}/kloc)`,
      findings:
        score < 1
          ? d.top.map((t) => ({
              severity: 'info',
              file: t.file,
              message: `${t.count} interface{}/any`,
            }))
          : [],
      suggestion:
        score < 1
          ? 'Every interface{}/any is a type assertion an agent has to guess. Prefer concrete types or generics (`[T any]` constraints are fine).'
          : undefined,
    };
  },
};

/** FFI binding crates (`openssl-sys/`) are unsafe by definition. */
const SYS_CRATE = /(^|\/)[\w-]+-sys\//;

/** `#![forbid(unsafe_code)]` in a crate root, or `unsafe_code = "forbid"` lints in Cargo.toml. */
function forbidsUnsafe(ctx: RepoContext): boolean {
  const cargo = ctx.read('Cargo.toml') ?? '';
  if (/^\s*unsafe_code\s*=\s*["'](?:forbid|deny)["']/m.test(cargo)) return true;
  const roots = ctx.files.filter(
    (f) => /(^|\/)src\/(?:lib|main)\.rs$/.test(f) && !isAuxiliaryPath(f) && !SYS_CRATE.test(f),
  );
  return (
    roots.length > 0 &&
    roots.every((f) => /#!\[(?:forbid|deny)\([^)]*\bunsafe_code\b/.test(ctx.read(f) ?? ''))
  );
}

const rustUnsafeCheck: Check = {
  id: 'types.rust-unsafe',
  category: 'types',
  title: 'Rust code keeps unsafe rare',
  weight: 1,
  async run(ctx): Promise<CheckResult> {
    if (!ctx.languages.includes('rust')) return { score: null, summary: 'No Rust' };
    // FFI binding crates (`*-sys`) are unsafe by definition.
    const files = productFiles(ctx, '.rs').filter((f) => !SYS_CRATE.test(f));
    if (files.length === 0) return { score: null, summary: 'No Rust product code' };
    if (forbidsUnsafe(ctx)) {
      return { score: 1, weightScale: ctx.share('rust'), summary: 'unsafe_code is forbidden' };
    }
    const d = await density(ctx, files, rustUnsafeCount);
    const score = densityScore(d.perKloc, 1, 20, 0.7);
    return {
      score,
      weightScale: ctx.share('rust'),
      summary: `${d.total} unsafe block(s)/fn(s) in ${Math.round(d.lines / 100) / 10}k lines of Rust (${d.perKloc.toFixed(1)}/kloc)`,
      findings:
        score < 1
          ? d.top.map((t) => ({ severity: 'info', file: t.file, message: `${t.count} unsafe` }))
          : [],
      suggestion:
        score < 1
          ? 'The compiler can’t check unsafe code for an agent. Wrap it in small, documented safe abstractions (with `// SAFETY:` comments) and add `#![deny(unsafe_code)]` where it isn’t needed.'
          : undefined,
    };
  },
};

/** A TOML array (`members = [...]`, possibly multi-line) inside `[section]`. */
export function tomlArray(text: string, section: string, key: string): string[] | null {
  const lines = text.split(/\r?\n/);
  let inSection = false;
  for (let i = 0; i < lines.length; i++) {
    const line = (lines[i] ?? '').trim();
    if (line.startsWith('[')) {
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

function globRe(glob: string): RegExp {
  let g = glob.trim().replace(/^\.\//, '');
  while (g.endsWith('/')) g = g.slice(0, -1);
  const body = g
    .split('')
    .map((ch) =>
      ch === '*' ? '[^/]*' : ch === '?' ? '[^/]' : /[.+^${}()|[\]\\]/.test(ch) ? `\\${ch}` : ch,
    )
    .join('');
  return new RegExp(`^${body}$`);
}

interface Workspace {
  dir: string;
  members: RegExp[];
  exclude: RegExp[];
}

const cargoWorkspaceCheck: Check = {
  id: 'feedback.cargo-workspace',
  category: 'feedback',
  title: 'One cargo workspace reaches every crate',
  weight: 1,
  run(ctx): CheckResult {
    if (!ctx.languages.includes('rust')) return { score: null, summary: 'No Rust' };
    // cargo-fuzz's `fuzz/` crate is its own workspace by design; examples and fixtures aren't product.
    const manifests = ctx.files.filter(
      (f) =>
        /(^|\/)Cargo\.toml$/.test(f) &&
        !isFixturePath(f) &&
        !isAuxiliaryPath(f) &&
        !/(^|\/)fuzz\//.test(f),
    );
    const crates: string[] = [];
    const workspaces: Workspace[] = [];
    /** Manifest dir -> crate dirs it depends on by `path = "..."`. */
    const pathDeps = new Map<string, string[]>();
    for (const m of manifests) {
      const text = ctx.read(m) ?? '';
      const dir = posix.dirname(m);
      pathDeps.set(
        dir,
        [...text.matchAll(/\bpath\s*=\s*["']([^"']+)["']/g)].map((x) =>
          posix.normalize(posix.join(dir, x[1] as string)),
        ),
      );
      if (/^\[package\]/m.test(text)) crates.push(dir);
      if (/^\[workspace\]/m.test(text)) {
        const rel = (g: string) => (dir === '.' ? g : posix.join(dir, g));
        workspaces.push({
          dir,
          members: (tomlArray(text, 'workspace', 'members') ?? []).map((g) => globRe(rel(g))),
          exclude: (tomlArray(text, 'workspace', 'exclude') ?? []).map((g) => globRe(rel(g))),
        });
      }
    }
    if (crates.length <= 1 && workspaces.length <= 1) {
      return { score: null, summary: crates.length ? 'Single crate' : 'No Cargo crates' };
    }
    const covers = (w: Workspace, crate: string) =>
      crate === w.dir ||
      (w.members.some((re) => re.test(crate)) && !w.exclude.some((re) => re.test(crate)));
    const excluded = (w: Workspace, crate: string) => w.exclude.some((re) => re.test(crate));
    // The entry point: the root workspace, else the workspace (or crate) that reaches the most crates.
    const rootWs = workspaces.find((w) => w.dir === '.');
    const primary =
      rootWs ??
      [...workspaces].sort(
        (a, b) =>
          crates.filter((c) => covers(b, c)).length - crates.filter((c) => covers(a, c)).length,
      )[0];
    // Cargo makes path dependencies of members (inside the workspace dir) members too.
    const reachedSet = new Set(crates.filter((c) => (primary ? covers(primary, c) : c === '.')));
    if (primary) reachedSet.add(primary.dir);
    const inside = (c: string) =>
      !primary || primary.dir === '.' || c.startsWith(`${primary.dir}/`);
    for (let changed = true; changed; ) {
      changed = false;
      for (const from of [...reachedSet]) {
        for (const dep of pathDeps.get(from) ?? []) {
          if (crates.includes(dep) && inside(dep) && !reachedSet.has(dep)) {
            reachedSet.add(dep);
            changed = true;
          }
        }
      }
    }
    const reached = (c: string) => reachedSet.has(c);
    // Crates the primary workspace deliberately excludes are a choice, not an oversight.
    const relevant = crates.filter((c) => !(primary && excluded(primary, c)));
    const missed = relevant.filter((c) => !reached(c));
    if (relevant.length === 0) return { score: null, summary: 'No Cargo crates' };
    const findings: Finding[] = [];
    const nested = workspaces.filter((w) => w !== primary);
    for (const w of nested) {
      const own = missed.filter((c) => covers(w, c));
      if (own.length) {
        findings.push({
          severity: 'warn',
          file: w.dir === '.' ? 'Cargo.toml' : `${w.dir}/Cargo.toml`,
          message: `separate workspace with ${own.length} crate(s): \`cargo test\` in ${primary?.dir ?? 'the root'} never builds them`,
        });
      }
    }
    for (const c of missed.filter((c) => !nested.some((w) => covers(w, c))).slice(0, 10)) {
      findings.push({
        severity: 'warn',
        file: c === '.' ? 'Cargo.toml' : `${c}/Cargo.toml`,
        message:
          'crate is in no workspace: add it to `[workspace] members` (or `exclude` it explicitly)',
      });
    }
    const where = primary
      ? primary.dir === '.'
        ? 'the root workspace'
        : `\`${primary.dir}/\``
      : 'the root crate';
    const score = (relevant.length - missed.length) / relevant.length;
    return {
      score,
      weightScale: ctx.share('rust'),
      summary:
        missed.length === 0
          ? `All ${relevant.length} crates are in ${where}`
          : `${missed.length} of ${relevant.length} crates are outside ${where}`,
      findings,
      suggestion: missed.length
        ? 'Agents run one `cargo test --workspace`; crates outside that workspace go unbuilt and untested. Add them to `members`, or document the extra workspace and its commands in AGENTS.md.'
        : undefined,
    };
  },
};

export const goRustChecks: Check[] = [goAnyCheck, rustUnsafeCheck, cargoWorkspaceCheck];
