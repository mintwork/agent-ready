import { execFileSync } from 'node:child_process';
import { lstatSync, realpathSync } from 'node:fs';
import { join, posix, relative, sep } from 'node:path';
import type { RepoContext } from '../context.js';
import type { Check, CheckResult, Finding } from '../types.js';
import { extractPathRefs, isPointerDoc } from './context-docs.js';
import { findContextDocs } from './docs.js';

/**
 * Doc staleness from git history (local `git log` only, never the network): a context doc that
 * nobody has touched while the code it points at kept changing probably describes code that no
 * longer exists in that form. Complements `context.fresh`, which catches references to paths that
 * are gone outright.
 */

/** A doc counts as drifting when it is at least this old (relative to HEAD)... */
export const MIN_AGE_DAYS = 90;
/** ...and at least this many later commits changed what it references. */
export const MIN_COMMITS = 25;

const MAX_DOCS = 20;
const MAX_REFS = 200;
const MAX_COMMITS_SCANNED = 5000;

function git(root: string, args: string[]): string | null {
  try {
    return execFileSync('git', args, {
      cwd: root,
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
  } catch {
    return null;
  }
}

/** Manifests, lockfiles and docs change for unrelated reasons (version bumps, new deps). */
const NOISY_REF =
  /(^|\/)(?:package(?:-lock)?\.json|pnpm-lock\.yaml|yarn\.lock|Cargo\.lock|go\.sum|poetry\.lock|uv\.lock|CHANGELOG[^/]*)$|\.(?:md|mdx|txt|rst)$/i;

export interface DocDrift {
  doc: string;
  /** Days between the doc's last commit and HEAD. */
  ageDays: number;
  /** Later commits that modified a referenced file or added/removed files in a referenced dir. */
  commits: number;
  /** Referenced paths that changed. */
  changedRefs: string[];
  refs: number;
}

const setsCache = new WeakMap<RepoContext, { fileSet: Set<string>; dirSet: Set<string> }>();

function pathSets(ctx: RepoContext): { fileSet: Set<string>; dirSet: Set<string> } {
  const cached = setsCache.get(ctx);
  if (cached) return cached;
  const dirSet = new Set<string>();
  for (const f of ctx.files) {
    for (let i = f.indexOf('/'); i !== -1; i = f.indexOf('/', i + 1)) dirSet.add(f.slice(0, i));
  }
  const sets = { fileSet: new Set(ctx.files), dirSet };
  setsCache.set(ctx, sets);
  return sets;
}

/** Existing, non-noisy paths a doc references, resolved like `context.fresh` does. */
function docRefs(
  ctx: RepoContext,
  docPath: string,
  content: string,
): { files: string[]; dirs: string[] } {
  const files = new Set<string>();
  const dirs = new Set<string>();
  const docDir = posix.dirname(docPath);
  const { fileSet, dirSet } = pathSets(ctx);
  for (const ref of extractPathRefs(content)) {
    const clean = ref.replace(/\/$/, '');
    const candidates = docDir === '.' ? [clean] : [posix.join(docDir, clean), clean];
    for (const c of candidates) {
      if (c.startsWith('..') || NOISY_REF.test(c)) continue;
      if (fileSet.has(c)) {
        files.add(c);
        break;
      }
      if (dirSet.has(c)) {
        dirs.add(c);
        break;
      }
    }
  }
  return { files: [...files].slice(0, MAX_REFS), dirs: [...dirs].slice(0, MAX_REFS) };
}

/** How much the code a doc references changed after the doc's last commit. Null if not measurable. */
export function docDrift(
  ctx: RepoContext,
  doc: string,
  content: string,
  headTime: number,
): DocDrift | null {
  const { files, dirs } = docRefs(ctx, doc, content);
  if (files.length + dirs.length === 0) return null;
  const last = git(ctx.root, ['log', '-1', '--format=%H %ct', '--', doc])?.trim();
  if (!last) return null; // untracked: brand new
  const [hash, time] = last.split(' ');
  const ageDays = Math.floor((headTime - Number(time)) / 86_400);
  // Recently edited docs can't be drifting; skip the (more expensive) history walk.
  if (ageDays < MIN_AGE_DAYS) {
    return { doc, ageDays, commits: 0, changedRefs: [], refs: files.length + dirs.length };
  }
  const out = git(ctx.root, [
    'log',
    '--relative',
    '--no-merges',
    '--no-renames',
    '--format=%x00',
    '--name-status',
    '-n',
    String(MAX_COMMITS_SCANNED),
    `${hash}..HEAD`,
    '--',
    ...files,
    ...dirs,
  ]);
  if (out === null) return null;
  const fileSet = new Set(files);
  const changed = new Set<string>();
  let commits = 0;
  for (const commit of out.split('\0').slice(1)) {
    let counts = false;
    for (const line of commit.split('\n')) {
      const m = /^([AMDT])\t(.+)$/.exec(line);
      if (!m) continue;
      const [, status, path] = m as unknown as [string, string, string];
      if (fileSet.has(path)) {
        counts = true;
        changed.add(path);
        continue;
      }
      // Inside a referenced directory only structural changes count: files added or removed.
      if (status === 'A' || status === 'D') {
        const dir = dirs.find((d) => path.startsWith(`${d}/`));
        if (dir) {
          counts = true;
          changed.add(dir);
        }
      }
    }
    if (counts) commits++;
  }
  return { doc, ageDays, commits, changedRefs: [...changed], refs: files.length + dirs.length };
}

/** Repo-relative target of a symlinked doc (null when not a symlink or it points outside). */
function symlinkTarget(ctx: RepoContext, rel: string): string | null {
  try {
    if (!lstatSync(join(ctx.root, rel)).isSymbolicLink()) return null;
    const target = relative(realpathSync(ctx.root), realpathSync(join(ctx.root, rel)));
    return target.startsWith('..') ? null : target.split(sep).join('/');
  } catch {
    return null;
  }
}

export function isDrifting(d: DocDrift): boolean {
  return d.ageDays >= MIN_AGE_DAYS && d.commits >= MIN_COMMITS;
}

export const docHistoryCheck: Check = {
  id: 'context.drift',
  category: 'context',
  title: 'Docs keep up with the code they describe (git history)',
  weight: 1,
  run(ctx): CheckResult {
    if (!ctx.isGit) return { score: null, summary: 'Not a git repository' };
    if (git(ctx.root, ['rev-parse', '--is-shallow-repository'])?.trim() === 'true') {
      return {
        score: null,
        summary: 'Shallow clone: needs full git history (in CI, `fetch-depth: 0`)',
      };
    }
    const head = Number(git(ctx.root, ['log', '-1', '--format=%ct'])?.trim());
    if (!Number.isFinite(head) || head === 0) return { score: null, summary: 'No commits yet' };
    const seen = new Set<string>();
    const drifts: DocDrift[] = [];
    for (const d of findContextDocs(ctx)) {
      if (drifts.length >= MAX_DOCS) break;
      // A symlinked CLAUDE.md never changes itself; its target's history is what matters.
      const path = symlinkTarget(ctx, d.path) ?? d.path;
      if (isPointerDoc(d.content) || seen.has(path)) continue;
      seen.add(path);
      const drift = docDrift(ctx, path, d.content, head);
      if (!drift) continue;
      // A drifting doc with uncommitted edits is being updated right now.
      if (isDrifting(drift) && git(ctx.root, ['diff', '--name-only', 'HEAD', '--', path])?.trim()) {
        continue;
      }
      drifts.push(drift);
    }
    if (drifts.length === 0) {
      return { score: null, summary: 'No committed context doc references code paths' };
    }
    const stale = drifts.filter(isDrifting);
    const findings: Finding[] = stale.map((d) => ({
      severity: 'warn',
      file: d.doc,
      message: `unchanged for ${d.ageDays} days while ${d.commits} later commits edited the files it names or added/removed files in the directories it describes (${d.changedRefs.length} of its ${d.refs} paths, e.g. ${d.changedRefs
        .slice(0, 3)
        .map((p) => `\`${p}\``)
        .join(', ')})`,
    }));
    const score = 1 - 0.5 * (stale.length / drifts.length);
    return {
      score,
      summary:
        stale.length === 0
          ? `${drifts.length} doc(s) kept up with the code they reference`
          : `${stale.length} of ${drifts.length} doc(s) untouched while the code they reference churned`,
      findings,
      suggestion: stale.length
        ? 'Re-read those docs against the current code and update them (even a small edit resets the clock). Docs that describe last year’s code mislead agents with confidence.'
        : undefined,
    };
  },
};
