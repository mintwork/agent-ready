import type { RepoContext } from './context.js';

export type CategoryId = 'context' | 'feedback' | 'navigability' | 'types' | 'safety';

export type Severity = 'error' | 'warn' | 'info';

export interface Finding {
  message: string;
  severity: Severity;
  file?: string;
  line?: number;
}

export interface CheckResult {
  /** 0..1, or null when the check does not apply to this repo. */
  score: number | null;
  /** One-line human summary. */
  summary: string;
  findings?: Finding[];
  /** Short actionable advice shown when the check is not passing. */
  suggestion?: string;
  /**
   * Optional multiplier (0..1] on the check's weight for this repo, e.g. the share of the code
   * written in the language the check is about.
   */
  weightScale?: number;
  /** Score this check would get without a temporary cap (e.g. an unedited generated doc). */
  potential?: number;
}

export interface FileChange {
  /** Path relative to repo root (posix). */
  path: string;
  /** Current content, or null when the file does not exist. */
  before: string | null;
  after: string;
  kind: 'create' | 'append' | 'overwrite';
  description: string;
}

export interface RunOptions {
  /** Actually execute the test command to time it. */
  run: boolean;
  /** Timeout for --run in ms. */
  runTimeoutMs: number;
}

export interface Check {
  id: string;
  category: CategoryId;
  title: string;
  /** Relative weight inside its category. */
  weight: number;
  run(ctx: RepoContext, opts: RunOptions): CheckResult | Promise<CheckResult>;
  /** Optional auto-fix. Returns proposed changes; never writes to disk itself. */
  fix?(ctx: RepoContext): FileChange[];
}

export interface CheckOutcome extends CheckResult {
  id: string;
  category: CategoryId;
  title: string;
  weight: number;
  fixable: boolean;
  durationMs: number;
}

export interface CategoryScore {
  id: CategoryId;
  title: string;
  weight: number;
  /** 0..100 or null when no checks applied. */
  score: number | null;
}

export interface Report {
  tool: { name: string; version: string };
  root: string;
  score: number;
  grade: string;
  categories: CategoryScore[];
  checks: CheckOutcome[];
  languages: string[];
  fileCount: number;
  /** Score once generated docs are filled in (equals `score` when nothing is capped). */
  potentialScore: number;
  /** Generated, still-unedited context docs holding the score back. */
  templateDocs: string[];
  /** True when the repo had more files than agent-ready scans; results cover a subset. */
  truncated: boolean;
  /** Wall time for the whole scan, including listing files. */
  durationMs: number;
  /** Per-package breakdown for monorepos (npm/pnpm/yarn/bun/Cargo/Go workspaces). */
  workspaces?: WorkspaceReport;
}

export interface PackageReport {
  /** Package directory relative to the repo root (`.` when the root is itself a package). */
  dir: string;
  name: string | null;
  /** Workspace tool that declared the package: npm, pnpm, yarn, bun, cargo or go. */
  kind: string;
  /**
   * 0..100 from the package-level categories (feedback loops, navigability, type safety) run on
   * the package alone; null when nothing applied. Context docs and safety are scored repo-wide.
   */
  score: number | null;
  categories: CategoryScore[];
  languages: string[];
  /** Product code files (tests, fixtures, examples excluded). Weights the aggregate. */
  codeFiles: number;
  /** Context docs inside the package (AGENTS.md / CLAUDE.md). */
  docs: string[];
  /** Whether the repo-level docs mention the package by path or name. */
  mentioned: boolean;
  /** Package-level checks that are not fully passing. */
  issues: Array<{ id: string; title: string; score: number; summary: string }>;
}

export interface WorkspaceReport {
  kinds: string[];
  /** Code-size-weighted mean of the package scores, or null when no package was scored. */
  aggregate: number | null;
  packages: PackageReport[];
  /** Total packages found; only the largest `packages.length` are scored when there are many. */
  total: number;
}

export interface UserConfig {
  /** Gitignore-style globs excluded from the scan. */
  ignore?: string[];
  /** Check ids to disable, e.g. "nav.depth". */
  disable?: string[];
}
