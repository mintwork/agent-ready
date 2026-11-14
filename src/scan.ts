import { builtinChecks } from './checks/index.js';
import { docQuality } from './checks/template.js';
import { createContext, type RepoContext } from './context.js';
import type {
  CategoryId,
  CategoryScore,
  Check,
  CheckOutcome,
  Report,
  RunOptions,
} from './types.js';
import { NAME, VERSION } from './version.js';

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
}

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

export async function scanContext(ctx: RepoContext, opts: ScanOptions = {}): Promise<Report> {
  const start = Date.now();
  const runOpts: RunOptions = {
    run: opts.run ?? false,
    runTimeoutMs: opts.runTimeoutMs ?? 300_000,
    flaky: opts.flaky ?? false,
  };
  const outcomes: CheckOutcome[] = [];
  // One concurrent stat pass is much faster than thousands of sync stats spread across checks.
  await ctx.prefetchSizes();
  for (const check of enabledChecks(ctx, opts.checks ?? builtinChecks)) {
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
      fixable: Boolean(check.fix) && score !== null && (potential ?? score) < 1,
      durationMs: Date.now() - t0,
    });
  }
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
  };
}

/** Scan a repository directory and return a scored report. */
export async function scan(root: string, opts: ScanOptions = {}): Promise<Report> {
  return scanContext(createContext(root), opts);
}
