Perform a release for this project. Steps:

1. Find the most recent version tag with `git describe --tags --abbrev=0` and collect all commits between it and HEAD using `git log {prev_tag}..HEAD --format="%B---"`
2. Bump the version with `npm version patch --no-git-tag-version`
3. Commit the version bump with message: `v{version}: {short summary of changes}`
4. Create a git tag `v{version}`
5. Push commits and tag: `git push && git push --tags`
6. Wait for the GitHub Actions build to complete using `gh run watch` on the latest run
7. Once the build finishes and creates a draft release, publish it with release notes using `gh release edit v{version} --draft=false --notes "..."`
8. Release notes format:
   ```
   ## What's Changed

   ### {Category}
   - {change description}

   ### {Category}
   - {change description}
   ```
   Group changes by category (e.g. "Features", "Bug Fixes", "Performance Improvements", etc.).

## Writing the release notes

Write them for the person using the app, not for someone reading the git log. Read every commit between the tags so nothing user-facing gets missed — but the notes describe what changed for the user, they are not a summary of each commit.

Each entry says what the user will notice: what the app did before, what it does now. Don't name internal symbols, columns, migrations, or files.

Leave out:

- **Fixes for bugs introduced after the previous tag.** The user never ran that code, so there's nothing to announce. Describe only the net change since the last release.
- Refactors, schema migrations, test-only changes, and dev tooling with no visible effect.
- Cosmetic tweaks too small to notice — padding, font sizes, color nudges.
- **Anything not confirmed to actually work.** If a change is unverified or known broken, raise it before publishing instead of listing it.

Collapse a feature and its follow-up fixes into a single entry describing where things landed. Several commits often add up to one user-facing change; one commit sometimes makes several.

A short release with three real entries beats a padded one with twelve. If nothing user-facing changed, say so plainly.
