import { join, posix } from 'node:path';
import type { RepoContext } from '../context.js';
import type { Check, CheckResult, Finding } from '../types.js';
import { isAuxiliaryPath, isFixturePath } from '../util/paths.js';

interface TsConfig {
  extends?: string | string[];
  compilerOptions?: Record<string, unknown>;
  files?: unknown[];
  include?: unknown[];
  references?: unknown[];
}

/** Workspace package name -> directory, for `"extends": "@repo/tsconfig/base.json"` without node_modules. */
function workspacePackages(ctx: RepoContext): Map<string, string[]> {
  const cached = wsCache.get(ctx);
  if (cached) return cached;
  const map = new Map<string, string[]>();
  for (const f of ctx.files) {
    if (!f.endsWith('package.json') || !/(^|\/)package\.json$/.test(f)) continue;
    const name = ctx.readJson<{ name?: string }>(f)?.name;
    if (typeof name !== 'string') continue;
    const dir = posix.dirname(f);
    map.set(name, [...(map.get(name) ?? []), dir]);
  }
  wsCache.set(ctx, map);
  return map;
}
const wsCache = new WeakMap<RepoContext, Map<string, string[]>>();

function commonPrefix(a: string, b: string): number {
  const x = a.split('/');
  const y = b.split('/');
  let i = 0;
  while (i < x.length && i < y.length && x[i] === y[i]) i++;
  return i;
}

function resolvePackageExtends(ctx: RepoContext, from: string, ext: string): string | null {
  const nm = [
    join('node_modules', ext),
    join('node_modules', `${ext}.json`),
    join('node_modules', ext, 'tsconfig.json'),
  ].find((c) => c.endsWith('.json') && ctx.exists(c));
  if (nm) return nm;
  const parts = ext.split('/');
  const nameLen = ext.startsWith('@') ? 2 : 1;
  const name = parts.slice(0, nameLen).join('/');
  const sub = parts.slice(nameLen).join('/');
  const dirs = workspacePackages(ctx).get(name);
  if (!dirs?.length) return null;
  // Several examples may define the same package name; prefer the one nearest the tsconfig.
  const dir = [...dirs].sort((a, b) => commonPrefix(b, from) - commonPrefix(a, from))[0] as string;
  const candidates = sub
    ? [posix.join(dir, sub), posix.join(dir, `${sub}.json`), posix.join(dir, sub, 'tsconfig.json')]
    : [posix.join(dir, 'tsconfig.json')];
  return candidates.find((c) => c.endsWith('.json') && ctx.exists(c)) ?? null;
}

/** Resolve compilerOptions through local, workspace-package and node_modules `extends` chains. */
export function resolveCompilerOptions(
  ctx: RepoContext,
  rel = 'tsconfig.json',
  depth = 0,
): Record<string, unknown> {
  if (depth > 8) return {};
  const cfg = ctx.readJson<TsConfig>(rel);
  if (!cfg) return {};
  let base: Record<string, unknown> = {};
  const exts =
    cfg.extends === undefined ? [] : Array.isArray(cfg.extends) ? cfg.extends : [cfg.extends];
  for (const ext of exts) {
    if (typeof ext !== 'string') continue;
    let target: string | null = null;
    if (ext.startsWith('.')) {
      target = posix.normalize(posix.join(posix.dirname(rel), ext));
      if (!target.endsWith('.json')) target += '.json';
    } else {
      // package config, e.g. "@tsconfig/strictest/tsconfig.json" or a workspace "@repo/tsconfig/base.json"
      target = resolvePackageExtends(ctx, rel, ext);
      if (!target && /strictest|strict/.test(ext)) base = { ...base, strict: true };
    }
    if (target) base = { ...base, ...resolveCompilerOptions(ctx, target, depth + 1) };
  }
  return { ...base, ...(cfg.compilerOptions ?? {}) };
}

/** A "solution" tsconfig that only lists project references and compiles nothing itself. */
function isSolutionConfig(cfg: TsConfig | null): boolean {
  if (!cfg) return true;
  return (
    Array.isArray(cfg.references) &&
    cfg.references.length > 0 &&
    Array.isArray(cfg.files) &&
    cfg.files.length === 0 &&
    !cfg.include
  );
}

const MAX_TSCONFIGS = 60;

/** The tsconfig.json files that define the product's TypeScript settings (root + packages). */
export function projectTsconfigs(ctx: RepoContext): string[] {
  const found = ctx.files
    .filter((f) => /(^|\/)tsconfig\.json$/.test(f) && !isFixturePath(f))
    .sort((a, b) => a.split('/').length - b.split('/').length || a.localeCompare(b));
  if (ctx.exists('tsconfig.json') && !found.includes('tsconfig.json'))
    found.unshift('tsconfig.json');
  // Prefer product configs; fall back to examples/playgrounds when that's all the TypeScript there is.
  const product = found.filter((f) => !isAuxiliaryPath(f));
  const all = product.length ? product : found;
  const real = all.filter((f) => !isSolutionConfig(ctx.readJson<TsConfig>(f)));
  return (real.length ? real : all).slice(0, MAX_TSCONFIGS);
}

/** Number of product TS files (min 1) whose nearest enclosing tsconfig is each config. */
function tsconfigWeights(ctx: RepoContext, tsconfigs: string[]): number[] {
  const dirs = tsconfigs.map((t) => {
    const d = posix.dirname(t);
    return d === '.' ? '' : `${d}/`;
  });
  const counts = tsconfigs.map(() => 0);
  for (const f of ctx.filesWithExt('.ts', '.tsx', '.mts', '.cts')) {
    if (f.endsWith('.d.ts') || isAuxiliaryPath(f)) continue;
    let best = -1;
    for (const [i, d] of dirs.entries()) {
      if (f.startsWith(d) && (best === -1 || d.length > (dirs[best] as string).length)) best = i;
    }
    if (best !== -1) counts[best] = (counts[best] ?? 0) + 1;
  }
  return counts.map((n) => Math.max(1, n));
}

/** `any` annotations/casts and `@ts-ignore` comments in one TypeScript file. */
export function escapeHatches(text: string): { anys: number; ignores: number } {
  return {
    ignores: (text.match(/(?:\/\/|\/\*+)\s*@ts-ignore/g) ?? []).length,
    anys: (text.match(/:\s*any\b|as any\b|<any>/g) ?? []).length,
  };
}

async function tsCheck(
  ctx: RepoContext,
): Promise<{ score: number; summary: string; findings: Finding[] }> {
  const findings: Finding[] = [];
  const tsconfigs = projectTsconfigs(ctx);
  let base: number;
  let summary: string;
  if (tsconfigs.length === 0) {
    base = 0.2;
    summary = 'TypeScript files but no tsconfig.json';
  } else {
    // Weight each config by the product TS files it governs (nearest tsconfig above the file), so a
    // loose config for a few dev scripts doesn't count as much as the main package.
    const weights = tsconfigWeights(ctx, tsconfigs);
    let total = 0;
    let totalW = 0;
    let strictCount = 0;
    const loose: string[] = [];
    let partialNames: string[] = [];
    for (const [i, t] of tsconfigs.entries()) {
      const w = weights[i] ?? 1;
      totalW += w;
      const opts = resolveCompilerOptions(ctx, t);
      if (opts.strict === true) {
        total += w;
        strictCount++;
        continue;
      }
      const partial = ['noImplicitAny', 'strictNullChecks', 'strictFunctionTypes'].filter(
        (k) => opts[k] === true,
      );
      if (loose.length === 0) partialNames = partial;
      total += w * (0.3 + 0.15 * partial.length);
      loose.push(t);
    }
    base = total / totalW;
    const n = tsconfigs.length;
    if (loose.length === 0) {
      summary =
        n === 1 ? `strict mode on (${tsconfigs[0]})` : `strict mode on (all ${n} tsconfigs)`;
    } else if (n === 1) {
      summary = partialNames.length
        ? `strict off; ${partialNames.join(', ')} on`
        : `strict mode off (${tsconfigs[0]})`;
    } else {
      summary = `strict mode on in ${strictCount} of ${n} tsconfigs`;
    }
    for (const t of loose.slice(0, 5)) {
      findings.push({
        severity: 'warn',
        file: t,
        message: 'set "strict": true in compilerOptions',
      });
    }
  }
  // Penalize escape hatches.
  const tsFiles = ctx
    .filesWithExt('.ts', '.tsx', '.mts', '.cts')
    .filter((f) => !f.endsWith('.d.ts') && !isFixturePath(f));
  let nocheck = 0;
  let ignores = 0;
  let anys = 0;
  const counts = await ctx.mapFiles(tsFiles.slice(0, 3000), (f, text) => ({
    f,
    nocheck: /^\s*(?:\/\/|\/\*+)\s*@ts-nocheck/m.test(text),
    ...escapeHatches(text),
  }));
  for (const c of counts) {
    if (!c) continue;
    if (c.nocheck) {
      nocheck++;
      if (nocheck <= 5)
        findings.push({
          severity: 'warn',
          file: c.f,
          message: '@ts-nocheck disables type checking',
        });
    }
    ignores += c.ignores;
    anys += c.anys;
  }
  const n = Math.max(1, tsFiles.length);
  const escapeRate = (nocheck * 5 + ignores + anys * 0.5) / n;
  const penalty = Math.min(0.3, escapeRate * 0.3);
  if (ignores + anys > 0) summary += `; ${anys} any, ${ignores} @ts-ignore`;
  return { score: Math.max(0, base - penalty), summary, findings };
}

/** Remove `# comments` from a parameter list (they may contain commas or parens). */
function stripComments(params: string): string {
  return params.replace(/#[^\n]*/g, '');
}

/** Split on commas that are not nested inside brackets or string literals: `Dict[str, int]` is one. */
export function splitTopLevel(params: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let quote: string | null = null;
  let cur = '';
  for (let i = 0; i < params.length; i++) {
    const ch = params[i] as string;
    if (quote) {
      if (ch === '\\') {
        cur += ch + (params[i + 1] ?? '');
        i++;
        continue;
      }
      if (ch === quote) quote = null;
    } else if (ch === '"' || ch === "'") quote = ch;
    else if (ch === '(' || ch === '[' || ch === '{') depth++;
    else if (ch === ')' || ch === ']' || ch === '}') depth--;
    else if (ch === ',' && depth === 0) {
      out.push(cur);
      cur = '';
      continue;
    }
    cur += ch;
  }
  out.push(cur);
  return out;
}

/** Estimate fraction of Python functions with type annotations. */
export function pythonAnnotationCoverage(source: string): { total: number; annotated: number } {
  let total = 0;
  let annotated = 0;
  const re = /^[ \t]*(?:async[ \t]+)?def[ \t]+\w+[ \t]*\(/gm;
  for (const m of source.matchAll(re)) {
    // Walk forward to the matching paren, then look for "->" before ":".
    let i = (m.index ?? 0) + m[0].length;
    let depth = 1;
    const start = i;
    while (i < source.length && depth > 0) {
      const ch = source[i];
      if (ch === '(' || ch === '[' || ch === '{') depth++;
      else if (ch === ')' || ch === ']' || ch === '}') depth--;
      i++;
    }
    const params = source.slice(start, i - 1);
    const after = source.slice(i, source.indexOf(':', i) + 1 || i + 200);
    total++;
    const paramList = splitTopLevel(stripComments(params))
      .map((p) => p.trim())
      .filter(
        (p) =>
          p &&
          p !== 'self' &&
          p !== 'cls' &&
          p !== '*' &&
          p !== '/' &&
          !p.startsWith('**') &&
          !/^\*\w*$/.test(p),
      );
    const hasReturn = /->/.test(after);
    const paramsAnnotated =
      paramList.length > 0 && paramList.every((p) => /^\*{0,2}\w+\s*:/.test(p));
    if (hasReturn || paramsAnnotated) annotated++;
  }
  return { total, annotated };
}

function pyCheck(ctx: RepoContext): { score: number; summary: string; findings: Finding[] } {
  const all = ctx
    .filesWithExt('.py')
    .filter((f) => !/(^|\/)(migrations|_pb2)/.test(f) && !isFixturePath(f));
  // Measure the product code: test functions (`def test_x():`), docs snippets and examples are
  // conventionally unannotated and say little about the types an agent will lean on.
  const product = all.filter((f) => !isAuxiliaryPath(f));
  const pyFiles = product.length > 0 ? product : all;
  let total = 0;
  let annotated = 0;
  for (const f of pyFiles.slice(0, 2000)) {
    const text = ctx.read(f);
    if (!text) continue;
    const r = pythonAnnotationCoverage(text);
    total += r.total;
    annotated += r.annotated;
  }
  const coverage = total === 0 ? 1 : annotated / total;
  const pyproject = ctx.pyproject ?? '';
  const checker =
    /\[tool\.(mypy|pyright|basedpyright)/.test(pyproject) ||
    ctx.has('mypy.ini') ||
    ctx.has('pyrightconfig.json');
  const strict =
    /^\s*strict\s*=\s*true/m.test(pyproject) || /typeCheckingMode\s*=\s*["']strict/.test(pyproject);
  const score = Math.min(1, coverage * 0.8 + (checker ? 0.15 : 0) + (strict ? 0.05 : 0));
  const pct = Math.round(coverage * 100);
  return {
    score,
    summary: `~${pct}% of ${total} Python functions annotated${checker ? `; type checker configured${strict ? ' (strict)' : ''}` : '; no type checker'}`,
    findings: [],
  };
}

export const typeSafetyChecks: Check[] = [
  {
    id: 'types.typescript',
    category: 'types',
    title: 'TypeScript strictness',
    weight: 1,
    async run(ctx): Promise<CheckResult> {
      if (!ctx.languages.includes('typescript')) {
        if (
          ctx.languages.includes('javascript') &&
          ctx.filesWithExt('.js', '.jsx', '.mjs', '.cjs').length > 0
        ) {
          const jsconfig = ctx.readJson<TsConfig>('jsconfig.json');
          const checkJs = jsconfig?.compilerOptions?.checkJs === true;
          return {
            weightScale: ctx.share('javascript'),
            score: checkJs ? 0.6 : 0.25,
            summary: checkJs
              ? 'JavaScript with checkJs enabled'
              : 'Plain JavaScript — no static types for agents to lean on',
            suggestion:
              'Migrate to TypeScript (or enable `checkJs` in jsconfig.json). Types are the cheapest feedback loop an agent has.',
          };
        }
        return { score: null, summary: 'No TypeScript/JavaScript' };
      }
      const r = await tsCheck(ctx);
      const strictOn = r.summary.startsWith('strict mode on (');
      return {
        ...r,
        weightScale: ctx.share('typescript', 'javascript'),
        suggestion:
          r.score < 1
            ? strictOn
              ? 'Burn down `any` and `@ts-ignore` escape hatches.'
              : 'Enable `"strict": true` and burn down `any` / `@ts-ignore`.'
            : undefined,
      };
    },
  },
  {
    id: 'types.python',
    category: 'types',
    title: 'Python type hint coverage',
    weight: 1,
    run(ctx): CheckResult {
      if (!ctx.languages.includes('python')) return { score: null, summary: 'No Python' };
      const r = pyCheck(ctx);
      return {
        ...r,
        weightScale: ctx.share('python'),
        suggestion:
          r.score < 0.9
            ? 'Annotate function signatures and configure mypy or pyright in pyproject.toml.'
            : undefined,
      };
    },
  },
  {
    id: 'types.static',
    category: 'types',
    title: 'Compiler-checked types (Go/Rust)',
    weight: 1,
    run(ctx): CheckResult {
      const langs = (['rust', 'go'] as const).filter((l) => ctx.languages.includes(l));
      if (langs.length === 0) return { score: null, summary: 'No Go/Rust' };
      return {
        score: 1,
        weightScale: ctx.share(...langs),
        summary: `${langs.map((l) => (l === 'rust' ? 'Rust' : 'Go')).join(' + ')}: statically typed, checked by the compiler`,
      };
    },
  },
];
