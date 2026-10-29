# Changelog

All notable changes to **Qwen Coder Minimal** are documented in this file.

Qwen Coder Minimal is a fork of [Qwen Code](https://github.com/QwenLM/qwen-code).
Each release below rebases the fork onto an upstream stable release; the
version number follows the upstream base. This file lists only what the fork
itself adds, changes or removes. For everything that came in from upstream, see
the linked upstream release notes.

This file is maintained by hand. It is no longer generated from upstream's
GitHub Releases.

## [0.25.1] - 2026-10-13

Rebased onto upstream
[v0.25.1](https://github.com/QwenLM/qwen-code/releases/tag/v0.25.1) (from
v0.24.7).

### Fixed

- Restore context-window auto-detection for models resolved from environment
  variables or `model.name` alone. Since the 0.24.7 rebase such models fell back
  to a 200K default, which is too high for 128K models (compaction never fired
  before the provider rejected requests) and too low for 256K/1M qwen3.x models.
- `package-lock.json` listed only the macOS arm64 builds of `rollup` and
  `lightningcss`, so the test tooling could not start on Linux or Windows.
- Terminal captures under tmux 3.2 (RHEL 9) now get the requested pane size
  instead of falling back to 80x24.
- `git worktree` prune candidates are returned in a stable order on every
  filesystem.
- A wedged git index now reports the stale `index.lock` hint on newer git.

### Security

- `npm audit --omit=dev` reports 0 vulnerabilities again: simple-git 4.0.2,
  shell-quote 1.12.0, proxy-addr 2.0.8, `@modelcontextprotocol/client` 2.3.1
  and katex 0.18.10. With simple-git 4, git child processes only receive the
  `GIT_*` variables the CLI sets on purpose.

### Removed

- Upstream's managed/hosted agent runtime, `qwen agents`, the
  `--acp-execution-engine` flag and the workspace-recovery worker entry, which
  belong to the removed daemon.
- Leftovers of removed packages: messaging channels (QQ Bot, DingTalk, Feishu,
  WeCom, Weixin, Telegram, DWS, email, GitHub/GitLab channels), the TypeScript
  and Java SDKs, `web-templates` and `audio-capture` — their docs, design notes,
  build aliases, CI references and Dependabot entries.

### Changed

- Unit suites pass on Linux (RHEL 9) as well as macOS.

## [0.24.7] - 2026-10-01

Rebased onto upstream
[v0.24.7](https://github.com/QwenLM/qwen-code/releases/tag/v0.24.7) (from
v0.21.15).

### Added

- Configurable model hub with a load indicator; reasoning probe and picker in
  `/model`.
- 600s OpenAI request timeout with no automatic retries; 256K context limits
  for qwen3.x open-weights models.

### Changed

- Authentication is OpenAI-compatible only (`openai` plus the Responses API);
  the provider dialog lists the configured hub and third-party presets.
- The project stays on npm (upstream moved to pnpm).

### Fixed

- Model discovery for the configured hub after the rebase.

### Removed

- Web Shell, desktop app, Qwen Live, browser use, Node REPL, computer use, IDE
  companion, voice, auto-update, insight and OTLP telemetry export brought in by
  the upstream base.

## [0.21.15] - 2026-08-24

Rebased onto upstream
[v0.21.15](https://github.com/QwenLM/qwen-code/releases/tag/v0.21.15) (from
v0.21.13).

### Added

- Memory search-index recall, goal terminal and model-hub providers carried
  forward; bundled skills.

### Removed

- Daemon, messaging channels, `web-templates`, SDKs, desktop app, Chrome
  extension, OTLP telemetry exporters and non-OpenAI authentication brought in by
  the upstream base.

## [0.21.13] - 2026-08-17

Rebased onto upstream
[v0.21.13](https://github.com/QwenLM/qwen-code/releases/tag/v0.21.13) (from
v0.21.10).

### Security

- `npm audit --omit=dev` reports 0 vulnerabilities (brace-expansion, fast-uri,
  hono, ip-address, undici, tar and sharp pinned to fixed versions).

### Removed

- Daemon, messaging channels, interaction telemetry, the DashScope provider and
  sensitive span attributes brought in by the upstream base.

## [0.21.10] - 2026-08-13

Rebased onto upstream
[v0.21.10](https://github.com/QwenLM/qwen-code/releases/tag/v0.21.10) (from
v0.20.1).

### Security

- Override `undici` and `tar` to fix the advisories the upstream dependency
  bump introduced.

### Changed

- Compact mode keeps `Ctrl+O`; expanding thinking moved to `Alt+T`.

## [0.20.1] - 2026-07-24

Rebased onto upstream
[v0.20.1](https://github.com/QwenLM/qwen-code/releases/tag/v0.20.1).

### Added

- Multi-model routing, auto-memory, cron, skills, transcript search index,
  plan-first write gate and compaction self-healing.

### Removed

- Usage telemetry and OTLP export, `/ide`, the `qwen serve` daemon, remote
  marketplace installs (extensions install from a local path only), non-OpenAI
  authentication, update checks, voice input and feedback, and UI locales other
  than English and Russian.
