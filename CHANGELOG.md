# Changelog

All notable changes to this project are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project follows
[Semantic Versioning](https://semver.org/). Until 1.0, scoring weights may still be tuned in minor
releases; any change that moves scores is called out here.

## [Unreleased]

### Added

- `--sarif`: SARIF 2.1.0 report for GitHub code scanning. Every check is a rule; findings of checks
  that aren't fully passing are results, located at the file (and line) they're about. Paths are
  relative to the git root, so scanning a subdirectory works. Scores are unchanged.
- GitHub Action: `sarif` input (uploads the report with `github/codeql-action/upload-sarif`),
  `sarif-category` input and `sarif-file` output.
- Monorepo awareness. npm/pnpm/yarn/bun workspaces, Cargo workspaces and Go multi-module repos are
  detected, and each package is scored on feedback loops, navigability and type safety. Root
  configs and root scripts count for the packages. The terminal report shows a per-package
  breakdown and a code-size-weighted aggregate; `--json` has a new `workspaces` field.
  `scan(root, { workspaces: false })` turns it off. The headline score is still repo-wide.
- New check `context.packages` (weight 1): large workspace packages (10+ code files) have their
  own `AGENTS.md`/`CLAUDE.md` or are mentioned in the root docs. It is n/a outside monorepos, so
  only monorepos with context docs can see a score change (e.g. vitest: context docs 87 → 88,
  overall unchanged at 91).
- `createPackageContext()` builds a context for one package from its repo's context.
- Agent tooling checks. Each one is n/a unless the repo ships that config, so repos that don't use
  a tool are unaffected:
  - `feedback.mcp` (weight 1): `.mcp.json`, `.cursor/mcp.json` and `.vscode/mcp.json` parse, and
    each server has a `command` or an http(s) `url`. Local scripts it runs must exist (build
    output and gitignored paths are skipped). Credentials should be `${VAR}` expansions, not
    literals.
  - `feedback.hooks` (weight 1): Claude Code hooks in `.claude/settings.json` use real event names
    (catches `preToolUse`-style typos), valid matcher regexes, the right shape and scripts that exist.
  - `safety.agent-permissions` (weight 1): flags committed `Bash`/`Bash(*)` allow rules,
    `defaultMode: "bypassPermissions"`, pre-approved shells/interpreters/`rm`/`curl`/`git push`,
    `enableAllProjectMcpServers`, and Codex `sandbox_mode = "danger-full-access"`.
  - `context.cursor-rules` (weight 1): every `.cursor/rules/*.mdc` applies on its own (frontmatter
    with `alwaysApply`, a `description` or `globs` that match files) and isn't empty.
    Score impact on repos that use these tools: Continuous-Claude-v3 49 → 50, nano-agent 44 → 46,
    spectrum-design-data 83 → 84; home-ops stays 52 (a rule that never applies, valid MCP config).
- Smarter `--fix`:
  - Hides committed generated, minified and vendored files flagged by `nav.generated`. It appends
    them to `.cursorignore` (Cursor) and `.ignore` (ripgrep: Claude Code, Codex), collapsing
    `generated/`/`vendor/`/`dist/` directories into one entry.
  - Creates `.env.example` from the env vars the product code reads (JS/TS, Python, Go, Rust,
    Ruby), but only when the project loads `.env` files (a dotenv library, or a local `.env*`
    exists) and no template exists. Names only: values are never copied.
  - Prints a TypeScript strict-mode migration plan for non-strict tsconfigs (flags in order, a
    `tsc --noEmit --<flag>` preview command, escape-hatch counts). Report only: tsconfigs are
    never edited.
  - Scores are unchanged.
- `--run` also runs the lint and typecheck commands. New checks `feedback.lint-passes` and
  `feedback.typecheck-passes` (weight 1 each) score 1 when the command passes, 0.4 when it fails and
  0.2 on timeout; a command that isn't installed is n/a. Scripts that publish or delete are never run.
- `--flaky` (implies `--run`): flaky-test detection. New check `feedback.flaky` (weight 1) runs the
  test command twice and compares exit status and failing test names (vitest/jest, pytest, go,
  cargo, TAP). The first run is shared with `feedback.speed`, so the suite runs twice, not three times.
- `--timeout <seconds>`: per-command timeout for `--run` (default 300).
- Scores without `--run` are unchanged. All new checks are n/a unless you opt in.

### Changed

- `--run` kills the whole process tree on timeout (it used to kill only the shell), and runs
  commands with `CI=1 NO_COLOR=1`.

## [0.1.1] - 2026-11-14

### Changed

- GitHub Action metadata for the GitHub Marketplace listing (author, description).
- Published from CI with npm trusted publishing (OIDC); no npm token is stored.
- README badges consolidated into one row.

## [0.1.0] - 2026-11-14

First public release.

### Added

- `agent-ready [path]`: scores a repo 0–100 on how well AI coding agents (Claude Code, Codex,
  Cursor, Copilot, Gemini) can work in it, across five weighted categories:
  - **Context docs (30%)**: `AGENTS.md` / `CLAUDE.md` / `.cursor/rules` / Copilot / Gemini
    instructions exist, list exact build/test/lint commands, describe the architecture, are not
    stale (every referenced path and `npm run` script exists) and are a sensible length.
  - **Feedback loops (25%)**: discoverable test command, linter, typecheck command, CI config;
    optional `--run` executes the tests and scores their speed.
  - **Navigability (20%)**: dependency and build output ignored, no oversized source files, no
    minified or generated blobs in agent view, shallow tree, README.
  - **Type safety (15%)**: TypeScript `strict` (follows `extends`, workspace-aware), `any` /
    `@ts-ignore` density, Python type-hint coverage and mypy/pyright config; Go and Rust count as
    compiler-checked.
  - **Safety (10%)**: committed `.env` files, keys and credentials, common token patterns, and
    dangerous scripts (`curl | sh`, `rm -rf ~`, force-push, `npm publish` hidden in `build`/`test`,
    network calls in install hooks).
- `--fix`: conservative auto-fixes (starter `AGENTS.md` + `CLAUDE.md`, missing doc sections,
  `.gitignore` entries). Prints a diff, never overwrites without `--force`; `--dry-run` previews.
- Generated docs earn partial credit (capped at 50%) until a human fills in the TODOs, and the CLI
  reports how many points are left to unlock.
- `--badge`: shields.io badge markdown for your README.
- `--json`: machine-readable report. `--min-score <n>`: exit 1 below a threshold for CI gating.
- `agent-ready.config.json` (or an `"agent-ready"` key in `package.json`) with `ignore` and
  `disable`; `agent-ready-ignore` comments silence single secret false positives.
- Language support: JavaScript/TypeScript and Python, with basic Go and Rust. Polyglot repos weight
  per-language checks by each language's share of the code.
- Composite GitHub Action (`uses: mintwork/agent-ready@v0`) with `path`, `min-score` and
  `version` inputs, a `score` output and a job summary. By default it runs the release matching the
  action tag.
- Programmatic API: `scan()`, `builtinChecks` and the `Check` type for custom checks.
- Zero runtime dependencies; Node 22+.

[0.1.1]: https://github.com/mintwork/agent-ready/releases/tag/v0.1.1
[0.1.0]: https://github.com/mintwork/agent-ready/releases/tag/v0.1.0
