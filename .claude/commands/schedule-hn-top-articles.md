---
name: Hacker News Top Article Check
cron: */5 * * * *
enabled: false
slug: hn-top-articles
cli:
  permission-mode: default
  allowed-tools: WebFetch
---

Check Hacker News for the current top article and any posts related to AI document conversion or extraction.

## Steps

1. Fetch the Hacker News front page (https://news.ycombinator.com) and identify the #1 ranked article. Log its title, URL, and point count.

2. Scan the full front page for any posts related to AI document conversion, document extraction, OCR, PDF parsing, or similar topics. If you find any, log each one with its title, URL, point count, and rank.

3. Output the results directly in the session (do not write to any file). Use this format:

```
--- [TIMESTAMP] ---
#1: [Title] ([points] points)
    [URL]

AI Doc/Extraction mentions:
- [Rank]. [Title] ([points] points)
  [URL]
(or "None found" if no relevant posts)
```

Keep the output concise. Do not summarize or editorialize the articles.
