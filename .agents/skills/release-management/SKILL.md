---
name: release-management
description: Workflow for recording changelog entries and cutting releases in acp-gateway. Covers semantic versioning, Keep a Changelog format, version bumping, and git tagging. Use this skill whenever adding a release entry, bumping version numbers, updating the changelog, tagging a release, or understanding the release workflow — even if the user just says they finished a feature and need to update the changelog.
---

# Release Management

## Overview

This project uses **semantic versioning** (`MAJOR.MINOR.PATCH`) and follows the [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) format. The changelog lives at `CHANGELOG.md` in the project root.

The [`keep-a-changelog`](https://www.npmjs.com/package/keep-a-changelog) npm package is installed as a dev dependency for parsing, validating, and formatting the changelog. It is an industry-standard tool for working with Keep a Changelog files.

Each release is tracked with a git tag (e.g. `1.0.0` — no `v` prefix), a version bump in `package.json`, and a changelog entry.

**Key rule: `package.json` version always reflects the last released (tagged) version.** It is only bumped when cutting a release, never when recording changes.

## CLI Tool: keep-a-changelog

The `keep-a-changelog` CLI is available via npm scripts:

| Command | Description |
|---------|-------------|
| `npm run changelog` | Parse and reformat `CHANGELOG.md` (fixes formatting, updates links) |
| `npm run changelog:check` | Validate `CHANGELOG.md` silently (for CI) |

### Creating a release with the CLI

Instead of manually editing the changelog when cutting a release, you can use:

```bash
npx keep-a-changelog --no-v-prefix --url https://github.com/josecanciani/acp-gateway --release <version>
```

This moves `[Unreleased]` entries into a new version heading with today's date and updates comparison links.

### Other useful commands

```bash
# Print the latest release version
npx keep-a-changelog --latest-release

# Initialize a new changelog (not needed — already exists)
npx keep-a-changelog --init
```

## Versioning Rules

- **MAJOR** (`X.0.0`): Breaking changes that require users to take action (e.g., renamed endpoints, changed config format, incompatible protocol changes).
- **MINOR** (`0.X.0`): New features, new adapters, new endpoints, or significant enhancements.
- **PATCH** (`0.0.X`): Bug fixes, small improvements, documentation-only changes, dependency updates.

When in doubt, ask the user which bump level to use.

## Change Categories

Use **only** these standard Keep a Changelog categories as `###` headings under each version:

| Category | Use for |
|----------|---------|
| `Added` | New features, new adapters, new endpoints |
| `Changed` | Changes to existing functionality |
| `Deprecated` | Features that will be removed in a future release |
| `Removed` | Features removed in this release |
| `Fixed` | Bug fixes |
| `Security` | Vulnerability fixes |

Omit categories that have no entries for a given release. Each entry is a bullet point (`-`) with a concise, user-facing description.

## Two Separate Workflows

### 1. Recording Changes (every commit)

After completing a feature or fix, add entries under `## [Unreleased]` in `CHANGELOG.md`:

1. Add bullet points under the appropriate category heading (`### Added`, `### Changed`, etc.).
2. Do **not** bump `package.json` — the version stays at the last released version.
3. Do **not** assign a version number to the unreleased entries — that is decided at release time.
4. Commit the changelog update together with the code changes.

### 2. Cutting a Release (on demand, when the user asks)

When the user decides to release:

1. **Determine the version bump** — ask the user or infer from the accumulated `[Unreleased]` changes.

2. **Bump the version in `package.json`**:
   ```bash
   npm version <major|minor|patch> --no-git-tag-version
   ```

3. **Update `CHANGELOG.md`** using the CLI tool:
   ```bash
   npx keep-a-changelog --no-v-prefix --url https://github.com/josecanciani/acp-gateway --release <version>
   ```
   This moves all `[Unreleased]` entries into a new version heading with today's date and updates comparison links.

   Alternatively, update manually:
   - Move all entries from `## [Unreleased]` into a new version heading.
   - Insert the new version block between `## [Unreleased]` (now empty) and the previous release.
   - Format: `## [X.Y.Z] - YYYY-MM-DD`
   - Update the comparison links at the bottom of the file.

4. **Commit the version bump and changelog together**:
   ```bash
   git add package.json CHANGELOG.md
   git commit -m "Bump version to X.Y.Z"
   ```

5. **Tag the release and push**:
   ```bash
   git tag X.Y.Z
   git push && git push origin X.Y.Z
   ```

## Changelog Format

The changelog (`CHANGELOG.md`) follows this structure:

```markdown
# Changelog
All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- Description of unreleased feature (no version number here).

## [X.Y.Z] - YYYY-MM-DD

### Added

- Released feature description.

### Fixed

- Released bug fix description.

[Unreleased]: https://github.com/josecanciani/acp-gateway/compare/X.Y.Z...main
[X.Y.Z]: https://github.com/josecanciani/acp-gateway/compare/X.Y.Z-1...X.Y.Z
[X.Y.Z-1]: https://github.com/josecanciani/acp-gateway/releases/tag/X.Y.Z-1
```

Key conventions:
- Newest version is always at the top, just below `## [Unreleased]`.
- `## [Unreleased]` never has a version number or date — those are assigned when cutting a release.
- Each version has a date in `YYYY-MM-DD` format (use the commit date).
- Version headings use brackets: `## [X.Y.Z] - YYYY-MM-DD`.
- Entries are concise bullet points under standard category headings.
- Comparison links at the bottom must be updated manually when cutting a release.

## Example

After adding a new `claude` adapter:

1. **Record the change** (committed with the code):
   - Add under `## [Unreleased]` -> `### Added`:
     ```markdown
     - New `claude` adapter for Anthropic's Claude agent.
     ```
   - `package.json` stays at current version (e.g. `1.0.0`).

2. **Later, cut a release** (when the user asks):
   ```bash
   npm version minor --no-git-tag-version   # 1.0.0 -> 1.1.0
   # Move [Unreleased] entries under ## [1.1.0] - 2026-04-19
   git add package.json CHANGELOG.md
   git commit -m "Bump version to 1.1.0"
   git tag 1.1.0
   git push && git push origin 1.1.0
   ```
