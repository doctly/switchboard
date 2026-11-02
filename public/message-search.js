// Search rendered message text without rewriting Markdown or its event handlers.
function createMessageSearch(viewer, body) {
  const bar = document.createElement('div');
  bar.className = 'terminal-search-bar message-search-bar';
  bar.style.display = 'none';
  bar.innerHTML = `
    <input type="text" class="terminal-search-input" placeholder="Find..." aria-label="Find in messages" />
    <span class="terminal-search-count" aria-live="polite"></span>
    <button class="terminal-search-prev" title="Previous (Shift+Enter)" aria-label="Previous match">&#x25B2;</button>
    <button class="terminal-search-next" title="Next (Enter)" aria-label="Next match">&#x25BC;</button>
    <button class="terminal-search-close" title="Close (Escape)" aria-label="Close search">&times;</button>`;
  viewer.appendChild(bar);
  const input = bar.querySelector('input');
  const count = bar.querySelector('.terminal-search-count');
  let matches = [], active = -1, timer = null;

  function clear() {
    CSS.highlights.delete('message-find');
    CSS.highlights.delete('message-find-active');
    matches = []; active = -1;
  }

  function goTo(index) {
    if (!matches.length) return;
    active = (index + matches.length) % matches.length;
    const range = matches[active];
    // A result may span inline Markdown elements inside a collapsed section.
    for (let el = range.startContainer.parentElement; el && el !== body; el = el.parentElement) {
      if (el.classList.contains('jsonl-tool-body') && el.style.display === 'none') {
        el.style.display = '';
        el.previousElementSibling?.classList.add('expanded');
      }
    }
    CSS.highlights.set('message-find-active', new Highlight(range));
    count.textContent = `${active + 1} of ${matches.length}`;
    const rect = range.getBoundingClientRect();
    const bounds = body.getBoundingClientRect();
    body.scrollBy({ top: rect.top - bounds.top - bounds.height / 2, behavior: 'instant' });
  }

  function refresh() {
    clearTimeout(timer); timer = null;
    clear();
    const query = input.value;
    count.textContent = '';
    if (!query || bar.style.display === 'none') return;
    // Index each rendered entry separately so a match cannot cross messages.
    const pattern = new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi');
    for (const entry of body.children) {
      const nodes = [];
      let text = '';
      const walker = document.createTreeWalker(entry, NodeFilter.SHOW_TEXT);
      for (let node; (node = walker.nextNode());) {
        if (node.parentElement.closest('script, style, button')) continue;
        nodes.push({ node, start: text.length });
        text += node.nodeValue;
      }
      let startIndex = 0, endIndex = 0;
      for (const match of text.matchAll(pattern)) {
        const end = match.index + match[0].length;
        while (startIndex + 1 < nodes.length && nodes[startIndex + 1].start <= match.index) startIndex++;
        endIndex = Math.max(startIndex, endIndex);
        while (endIndex + 1 < nodes.length && nodes[endIndex + 1].start < end) endIndex++;
        const range = document.createRange();
        range.setStart(nodes[startIndex].node, match.index - nodes[startIndex].start);
        range.setEnd(nodes[endIndex].node, end - nodes[endIndex].start);
        matches.push(range);
      }
    }
    const highlight = new Highlight();
    for (const range of matches) highlight.add(range);
    CSS.highlights.set('message-find', highlight);
    count.textContent = matches.length ? `${matches.length} found` : 'No results';
    if (matches.length) goTo(0);
  }

  function close(focus = true) {
    clearTimeout(timer); timer = null;
    clear();
    bar.style.display = 'none'; input.value = ''; count.textContent = '';
    if (focus) { body.tabIndex = -1; body.focus({ preventScroll: true }); }
  }

  function next(direction) {
    if (timer !== null) { refresh(); if (direction > 0) return; }
    goTo(active + direction);
  }
  input.addEventListener('input', () => {
    clearTimeout(timer);
    timer = setTimeout(refresh, 100);
  });
  bar.addEventListener('keydown', event => {
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close(); }
    else if (event.key === 'Enter' && event.target === input) { event.preventDefault(); next(event.shiftKey ? -1 : 1); }
  });
  bar.querySelector('.terminal-search-prev').onclick = () => next(-1);
  bar.querySelector('.terminal-search-next').onclick = () => next(1);
  bar.querySelector('.terminal-search-close').onclick = () => close();
  return {
    open() {
      const selection = window.getSelection();
      const selected = selection?.rangeCount && body.contains(selection.anchorNode) && body.contains(selection.focusNode)
        ? selection.toString() : '';
      const opening = bar.style.display === 'none';
      bar.style.display = 'flex';
      if (selected) input.value = selected;
      input.focus(); input.select();
      if (opening || selected) refresh();
    },
    close, refresh,
  };
}
