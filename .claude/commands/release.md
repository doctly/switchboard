Perform a release for this project. Steps:

1. Find the most recent version tag with `git describe --tags --abbrev=0` and collect all commits between it and HEAD using `git log {prev_tag}..HEAD --format="%B---"`

2. Summarize the changes into human-readable release notes (see format below). Present this summary to the user **before proceeding**.

3. Bump the version with `npm version patch --no-git-tag-version`

4. Commit the version bump with message: `v{version}: {short one-line summary of changes}`

5. Create a git tag `v{version}`

6. Push commits and tag: `git push && git push --tags`

7. Wait for the GitHub Actions build to complete using `gh run watch` on the latest run

8. Once the build finishes and creates a draft release, publish it with:
   ```
   gh release edit v{version} --draft=false --notes "..."
   ```

9. Tell the user:
   > Release published! To update the GitHub repo description and topics, go to:
   > **https://github.com/fortael/wootonpad** → click the ⚙️ gear icon next to "About"
   >
   > Suggested description:
   > `Session manager and IDE emulator for Claude Code. Multi-account, full-text search, diff review, plans & memory browser.`
   >
   > Suggested topics: `claude-code`, `electron`, `ai`, `developer-tools`, `session-manager`

---

## Release notes format

```
## What's Changed

### {Category}
- {change description}

### {Category}
- {change description}
```

Group changes by category (e.g. "Features", "Bug Fixes", "Improvements", "Internal") based on the commit messages. Cover **all** commits between the previous tag and the new tag — don't skip any. Keep descriptions concise and user-facing (what changed, not how).
