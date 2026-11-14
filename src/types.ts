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
  /** Timeout for each command --run executes, in ms. */
  runTimeoutMs: number;
  /** With `run`: run the test command a second time and compare (flaky-test detection). */
  flaky?: boolean;
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
}

export interface UserConfig {
  /** Gitignore-style globs excluded from the scan. */
  ignore?: string[];
  /** Check ids to disable, e.g. "nav.depth". */
  disable?: string[];
}
