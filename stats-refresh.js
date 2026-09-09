const fs = require('node:fs');

function stripTerminal(output) {
  return output
    .replace(/\x1b\][\s\S]*?(?:\x07|\x1b\\)/g, '')
    // Ink positions words using absolute columns instead of literal spaces.
    .replace(/\x1b\[[0-?]*[ -/]*([@-~])/g, (_, command) => /[GHf]/.test(command) ? ' ' : '')
    .replace(/\x1b[^[\]].?/g, '');
}

function selectedTrustOption(output) {
  const matches = [...output.matchAll(/[❯›>]\s*(?:\d+\.\s*)?(Yes|No)\b/gi)];
  return matches.at(-1)?.[1].toLowerCase();
}

// Keep navigation and confirmation in separate writes. Wait for Claude to
// render the selected Yes before pressing Enter, including on older CLIs that
// already select Yes. Never confirm an unknown selection.
function runStatsCommand({ spawn, shell, args, options, timeoutMs = 10000 }) {
  return new Promise((resolve) => {
    let p, timeout, inputTimer;
    let output = '';
    let settled = false;
    let trustPrompt = false;
    let moved = false;
    let confirmed = false;
    const subscriptions = [];

    function finish(error = null) {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      clearTimeout(inputTimer);
      for (const subscription of subscriptions) subscription?.dispose();
      try { p?.kill(); } catch {}
      resolve({ error });
    }

    function sendAfterRender(key, delay) {
      inputTimer = setTimeout(() => {
        inputTimer = null;
        if (settled) return;
        // Recheck in case another render changed the selection while waiting.
        const selected = selectedTrustOption(stripTerminal(output));
        if (key === '\r' ? selected !== 'yes' : selected !== 'no') return;
        if (key === '\r') confirmed = true;
        else moved = true;
        output = '';
        try { p.write(key); }
        catch { finish('Could not confirm the folder trust prompt.'); }
      }, delay);
    }

    try {
      p = spawn(shell, args, options);
      timeout = setTimeout(() => finish('Stats refresh timed out.'), timeoutMs);
      subscriptions.push(p.onData((data) => {
        if (settled) return;
        output = (output + data).slice(-65536);
        const text = stripTerminal(output);
        if (!confirmed) {
          if (/trust[^\r\n]*folder/i.test(text)) trustPrompt = true;
          if (trustPrompt) {
            const selected = selectedTrustOption(text);
            if (!inputTimer) {
              if (selected === 'no' && !moved) sendAfterRender('\x1b[B', 1000);
              else if (selected === 'yes') sendAfterRender('\r', moved ? 100 : 1000);
            }
            return;
          }
        }
        if (/streak/i.test(text)) finish();
      }));
      subscriptions.push(p.onExit(() => finish('Claude exited before stats finished.')));
    } catch {
      finish('Could not start Claude to refresh stats.');
    }
  });
}

function readStatsCache(cachePath) {
  try {
    const stats = JSON.parse(fs.readFileSync(cachePath, 'utf8'));
    if (!stats || typeof stats !== 'object' || Array.isArray(stats)) return null;
    return { stats, mtimeMs: fs.statSync(cachePath).mtimeMs };
  } catch {
    return null;
  }
}

async function refreshStatsCache(cachePath, run, now = () => new Date()) {
  const before = readStatsCache(cachePath);
  let error;
  try { ({ error } = await run()); }
  catch { error = 'Could not refresh stats.'; }
  const after = readStatsCache(cachePath);

  if (!error) {
    if (!after) {
      error = 'Stats refresh finished without a readable cache.';
    } else {
      // Claude caches completed UTC days; today's activity is computed in its
      // UI. An unchanged cache through yesterday is normal on repeat refreshes.
      const yesterday = new Date(now());
      yesterday.setUTCDate(yesterday.getUTCDate() - 1);
      const lastDate = after.stats.lastComputedDate;
      const current = typeof lastDate === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(lastDate)
        && lastDate >= yesterday.toISOString().slice(0, 10);
      const advanced = !before || after.mtimeMs > before.mtimeMs
        || (typeof lastDate === 'string' && lastDate > before.stats.lastComputedDate);
      if (!current && !advanced) error = 'Stats cache did not advance after refreshing.';
    }
  }

  return { stats: after?.stats || before?.stats || null, statsError: error || null };
}

module.exports = { runStatsCommand, refreshStatsCache };
