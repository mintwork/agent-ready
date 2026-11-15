import { builtinChecks } from './checks/index.js';
import { docQuality } from './checks/template.js';
import { packageDocs } from './checks/workspace-docs.js';
import { createContext, createPackageContext, type RepoContext } from './context.js';
import type {
  CategoryId,
  CategoryScore,
  Check,
  CheckOutcome,
  PackageReport,
  Report,
  RunOptions,
  WorkspaceReport,
} from './types.js';
import { NAME, VERSION } from './version.js';
import { detectWorkspaces, packageCodeFiles } from './workspaces.js';

export const CATEGORIES: Array<{ id: CategoryId; title: string; weight: number }> = [
  { id: 'context', title: 'Context docs', weight: 30 },
  { id: 'feedback', title: 'Feedback loops', weight: 25 },
  { id: 'navigability', title: 'Navigability', weight: 20 },
  { id: 'types', title: 'Type safety', weight: 15 },
  { id: 'safety', title: 'Safety', weight: 10 },
];

export function grade(score: number): string {
  if (score >= 90) return 'Excellent';
  if (score >= 75) return 'Good';
  if (score >= 50) return 'Fair';
  return 'Poor';
}

export interface ScanOptions extends Partial<RunOptions> {
  checks?: Check[];
  /** Score each workspace package of a monorepo too (default true). */
  workspaces?: boolean;
}

/** Categories that make sense for one package on its own; docs and safety are repo-wide. */
const PACKAGE_CATEGORIES = new Set<CategoryId>(['feedback', 'navigability', 'types']);
/**
 * Repo-level checks inside those categories: one CI, README and cargo workspace per repo is
 * normal, and the --run checks run once for the whole repo.
 */
const REPO_ONLY_CHECKS = new Set([
  'feedback.ci',
  'feedback.speed',
  'feedback.lint-passes',
  'feedback.typecheck-passes',
  'feedback.flaky',
  'feedback.cargo-workspace',
  'nav.readme',
]);
/** Packages scored one by one (the largest by code size); the rest are only counted. */
const MAX_SCORED_PACKAGES = 60;

export function enabledChecks(ctx: RepoContext, checks: Check[]): Check[] {
  const disabled = new Set(ctx.config.disable ?? []);
  return checks.filter((c) => !disabled.has(c.id) && !disabled.has(c.category));
}

export function computeScores(outcomes: CheckOutcome[]): {
  score: number;
  categories: CategoryScore[];
} {
  const categories: CategoryScore[] = CATEGORIES.map((cat) => {
    const applicable = outcomes.filter((o) => o.category === cat.id && o.score !== null);
    const w = applicable.reduce((s, o) => s + o.weight, 0);
    const score =
      w === 0 ? null : (applicable.reduce((s, o) => s + (o.score ?? 0) * o.weight, 0) / w) * 100;
    return { ...cat, score: score === null ? null : Math.round(score) };
  });
  const scored = categories.filter((c) => c.score !== null);
  const totalW = scored.reduce((s, c) => s + c.weight, 0);
  const score =
    totalW === 0 ? 0 : scored.reduce((s, c) => s + (c.score ?? 0) * c.weight, 0) / totalW;
  return { score: Math.round(score), categories };
}

async function runChecks(
  ctx: RepoContext,
  checks: Check[],
  runOpts: RunOptions,
): Promise<CheckOutcome[]> {
  const outcomes: CheckOutcome[] = [];
  // One concurrent stat pass is much faster than thousands of sync stats spread across checks.
  await ctx.prefetchSizes();
  for (const check of checks) {
    const t0 = Date.now();
    let result: Awaited<ReturnType<Check['run']>>;
    try {
      result = await check.run(ctx, runOpts);
    } catch (err) {
      result = { score: null, summary: `Check crashed: ${(err as Error).message}` };
    }
    const score = result.score === null ? null : Math.max(0, Math.min(1, result.score));
    const potential =
      result.potential === undefined ? undefined : Math.max(0, Math.min(1, result.potential));
    outcomes.push({
      ...result,
      score,
      potential,
      id: check.id,
      category: check.category,
      title: check.title,
      weight: check.weight * Math.max(0.05, Math.min(1, result.weightScale ?? 1)),
      // A score held back only by an unedited generated doc isn't something --fix can improve.
      fixable: check.fix !== undefined && score !== null && (potential ?? score) < 1,
      durationMs: Date.now() - t0,
    });
  }
  return outcomes;
}

/** Score every workspace package on the package-level categories. */
export async function scanWorkspaces(
  ctx: RepoContext,
  checks: Check[] = builtinChecks,
): Promise<WorkspaceReport | undefined> {
  const ws = detectWorkspaces(ctx);
  if (!ws) return undefined;
  const pkgChecks = enabledChecks(ctx, checks).filter(
    (c) => PACKAGE_CATEGORIES.has(c.category) && !REPO_ONLY_CHECKS.has(c.id),
  );
  const sized = ws.packages
    .map((pkg) => ({ pkg, codeFiles: packageCodeFiles(ctx, ws, pkg) }))
    .sort((a, b) => b.codeFiles - a.codeFiles)
    .slice(0, MAX_SCORED_PACKAGES);
  const nestedDirs = ws.packages.map((p) => p.dir).filter((d) => d !== '.');
  const packages: PackageReport[] = [];
  for (const { pkg, codeFiles } of sized) {
    // A package's own nested packages (and, for the root package, every other one) are scored separately.
    const inner = nestedDirs.filter((d) => pkg.dir === '.' || d.startsWith(`${pkg.dir}/`));
    const pctx = createPackageContext(ctx, pkg.dir, inner);
    const outcomes = await runChecks(pctx, pkgChecks, { run: false, runTimeoutMs: 0 });
    const scored = computeScores(outcomes);
    const applicable = outcomes.some((o) => o.score !== null);
    const docs = packageDocs(ctx, pkg);
    packages.push({
      dir: pkg.dir,
      name: pkg.name,
      kind: pkg.kind,
      score: applicable ? scored.score : null,
      categories: scored.categories.filter((c) => PACKAGE_CATEGORIES.has(c.id)),
      languages: pctx.languages,
      codeFiles,
      docs: docs.nested,
      mentioned: docs.mentioned,
      issues: outcomes
        .filter((o) => o.score !== null && o.score < 0.999)
        .map((o) => ({
          id: o.id,
          title: o.title,
          score: Math.round((o.score ?? 0) * 100) / 100,
          summary: o.summary,
        })),
    });
  }
  packages.sort((a, b) => a.dir.localeCompare(b.dir));
  const rated = packages.filter((p) => p.score !== null);
  const w = rated.reduce((n, p) => n + Math.max(1, p.codeFiles), 0);
  const aggregate =
    w === 0
      ? null
      : Math.round(rated.reduce((n, p) => n + (p.score ?? 0) * Math.max(1, p.codeFiles), 0) / w);
  return { kinds: ws.kinds, aggregate, packages, total: ws.packages.length };
}

export async function scanContext(ctx: RepoContext, opts: ScanOptions = {}): Promise<Report> {
  const start = Date.now();
  const runOpts: RunOptions = {
    run: opts.run ?? false,
    runTimeoutMs: opts.runTimeoutMs ?? 300_000,
    flaky: opts.flaky ?? false,
  };
  const checks = opts.checks ?? builtinChecks;
  const outcomes = await runChecks(ctx, enabledChecks(ctx, checks), runOpts);
  const workspaces =
    opts.workspaces === false || ctx.parent ? undefined : await scanWorkspaces(ctx, checks);
  const { score, categories } = computeScores(outcomes);
  const potentialScore = outcomes.some((o) => o.potential !== undefined)
    ? computeScores(outcomes.map((o) => ({ ...o, score: o.potential ?? o.score }))).score
    : score;
  const templateDocs = potentialScore > score ? docQuality(ctx).templateDocs : [];
  return {
    tool: { name: NAME, version: VERSION },
    root: ctx.root,
    score,
    grade: grade(score),
    potentialScore,
    templateDocs,
    categories,
    checks: outcomes,
    languages: ctx.languages,
    fileCount: ctx.files.length,
    truncated: ctx.truncated,
    durationMs: Date.now() - start + ctx.setupMs,
    ...(workspaces ? { workspaces } : {}),
  };
}

/** Scan a repository directory and return a scored report. */
export async function scan(root: string, opts: ScanOptions = {}): Promise<Report> {
  return scanContext(createContext(root), opts);
}
