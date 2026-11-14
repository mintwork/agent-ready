# Changelog

All notable changes to this project are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project follows
[Semantic Versioning](https://semver.org/). Until 1.0, scoring weights may still be tuned in minor
releases; any change that moves scores is called out here.

## [Unreleased]

### Added

- Basic Java/Kotlin support:
  - Detection: a root `pom.xml`/`build.gradle(.kts)`/`settings.gradle(.kts)` with `.java`/`.kt`
    files, or a significant share of JVM code. An `android/` folder in a JS app does not count.
  - The existing checks now score the JVM side:
    - `feedback.test`: tests under `src/test/` or `*Test`/`*IT`/`*Spec`, run via
      `./mvnw test`/`mvn test`/`./gradlew test`.
    - `feedback.lint`: checkstyle, spotless, PMD, SpotBugs, Error Prone, ktlint or detekt in the
      build or config files (1.0), otherwise compiler warnings only (0.6).
    - `feedback.typecheck`: compile.
    - `types.static`: Java/Kotlin count as compiler-checked.
  - `--fix` generates Maven/Gradle build and test commands, and docs that list `./mvnw` commands
    are recognized.
  - `target/` (Maven, Cargo) is suggested for `.gitignore` when it is present, untracked and
    not ignored.
  - Score effect: Java repos used to be scored on CI alone, with type safety n/a. Now, for
    example: gson 61 → 67, spring-petclinic 63 → 69, timber 58 → 64. No non-JVM repo moved.

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
