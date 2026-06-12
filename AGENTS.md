# AGENTS.md

## Universal Rules

Read and follow `~/.skaleet-ai/conventions/rules.md` — it contains mandatory rules for all Skaleet projects (architecture, testing, git, AI agent behavior, shell commands).

## Local Instructions

Read `.ai/shared-guidelines.md` at the start of any work and follow it as the single source of truth for this project.

## Conventions

Shared development conventions are available at `~/.skaleet-ai/conventions/`. Read the relevant guide when working on a specific topic:

- **Architecture**: `conventions/architecture.md` — DDD/CQRS, Clean Architecture, bounded context isolation
- **Code Style**: `conventions/code-style.md` — PSR-12, naming conventions
- **TDD**: `conventions/tdd/_base.md` + language-specific (`php.md`, `typescript.md`)
- **Commit Messages**: `conventions/how-to/commit-messages.md` — Conventional Commits (mandatory)
- **How-To Guides**: `conventions/how-to/` — command-handler, api-endpoint, datagrid, etc.

## CLI Tools

Shared CLI tools are installed in `~/.skaleet-ai/bin/`. Use the full path to invoke them:

- **lsp-query**: Code intelligence via LSP (definition, references, hover, rename, diagnostics). Use when the IDE is not available. Usage: `~/.skaleet-ai/bin/lsp-query <action> <language> <file> [line] [col] [extra]`. Read `~/.skaleet-ai/conventions/how-to/lsp-query.md` for full documentation.

## Project Detection

- `composer.json` with PHP require -> PHP project (read `conventions/tdd/php.md`)
- `tsconfig.json` -> TypeScript project (read `conventions/tdd/typescript.md`)
- Check project's `.ai/shared-guidelines.md` for project-specific rules
