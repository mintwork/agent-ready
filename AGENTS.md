# AGENTS.md

Guidance for AI coding agents (Claude Code, Codex, Cursor, Copilot) working on **agent-ready** —
a CLI that scores how well AI agents can work in a repo, and auto-fixes the gaps.

## Commands

```bash
npm install          # install dev dependencies (no runtime deps — keep it that way)
npm run build        # tsc -> dist/
npm test             # vitest (fixtures are copied to a temp dir per test)
npm run lint         # biome check .
npm run typecheck    # tsc --noEmit
npm run check        # typecheck + lint + test; run before finishing any task
node dist/bin.js .   # run the CLI against this repo (build first)
npm run demo:gif     # rebuild docs/demo.gif (needs Google Chrome + ffmpeg)
```

## Architecture

- `src/bin.ts` — executable entry; calls `main()` in `src/cli.ts` (arg parsing, output modes, `--fix` flow).
- `src/context.ts` — builds a `RepoContext`: the agent-visible file list (via `git ls-files`, or a
  filesystem walk honoring `.gitignore`), cached reads, package.json / pyproject, detected languages.
- `src/checks/` — one file per category. Each check is a `Check` (see `src/types.ts`) returning a
  0..1 score (or `null` = not applicable), findings, and an optional `fix()` that _proposes_ `FileChange`s.
  Register new checks in `src/checks/index.ts`.
- `src/scan.ts` — runs checks and computes weighted category/overall scores (`CATEGORIES`).
- `src/fix/` — `agents-md.ts` generates starter docs; `env-example.ts` builds the env-var template (names
  only, never values); `strict-plan.ts` is the report-only tsconfig strict plan; `index.ts` plans and
  applies changes safely.
- `src/report/` — terminal renderer and shields.io badge.
- `src/util/` — tiny zero-dep helpers: gitignore matcher, JSONC parser, line diff, ANSI colors,
  path classifiers (`paths.ts`: test/fixture/example paths).
- `scripts/demo-gif.mjs` — renders the real CLI output on a synthetic temp repo into `docs/demo.gif`
  (Playwright + Chrome, ffmpeg). Never point it at real repos.
- `docs/` — demo visuals, release notes and launch drafts.
- `examples/` — copy-paste CI workflow; `action.yml` at the root is the reusable GitHub Action.
- `test/` — vitest suites; `test/fixtures/` holds good/bad sample repos (excluded from our own scan
  via `agent-ready.config.json`).

## Conventions

- Zero runtime dependencies. Node 22+ built-ins only.
- Fixers never write directly: they return `FileChange`s; `applyFixes` refuses to overwrite without `--force`.
- Checks must be fast (whole scan < 2s on a typical repo) and must not execute project code unless `--run` is passed.
  To read many files, use `ctx.mapFiles()` (concurrent, uncached) rather than `ctx.read()` in a loop.
- Per-language checks should return `weightScale: ctx.share(lang)` (or weight their parts by it) so
  minor languages in a polyglot repo don't dominate.
- Test fixtures, examples and docs are not product code: use `src/util/paths.ts` to keep them from
  triggering findings meant for the product (secrets, oversized files, type coverage).
- `test/field.test.ts` holds regressions for false positives found on real repos — synthetic snippets only.
- Never put real-looking secrets in source or tests — build them from string pieces (see `test/helpers.ts`).
- Every new check needs a test against a fixture that fails it and one that passes it.

## Gotchas

- Scoring changes shift everyone's badge. Treat weights in `src/scan.ts` and per-check `weight` as public API.
- Unedited generated docs are capped (`src/checks/template.ts`): if you change the template in
  `src/fix/agents-md.ts`, keep `GENERATED_MARKER` and the `TODO` placeholders, or `--fix` output
  will start earning full credit.
- `git ls-files -c` includes deleted-but-unstaged files; reads return `null` for those, so always handle `null`.
