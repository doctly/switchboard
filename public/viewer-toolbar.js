/**
 * viewer-toolbar.js — Shared toolbar factory for all CodeMirror viewer panels.
 *
 * Creates a consistent toolbar with title, path, and action buttons.
 * Used by plan viewer, memory viewer, and file panel.
 */

const SAVE_ICON = '<svg stroke="currentColor" fill="currentColor" stroke-width="0" viewBox="0 0 448 512" width="14" height="14" xmlns="http://www.w3.org/2000/svg"><path d="M433.941 129.941l-83.882-83.882A48 48 0 0 0 316.118 32H48C21.49 32 0 53.49 0 80v352c0 26.51 21.49 48 48 48h352c26.51 0 48-21.49 48-48V163.882a48 48 0 0 0-14.059-33.941zM272 80v80H144V80h128zm122 352H54a6 6 0 0 1-6-6V86a6 6 0 0 1 6-6h42v104c0 13.255 10.745 24 24 24h176c13.255 0 24-10.745 24-24V83.882l78.243 78.243a6 6 0 0 1 1.757 4.243V426a6 6 0 0 1-6 6zM224 232c-48.523 0-88 39.477-88 88s39.477 88 88 88 88-39.477 88-88-39.477-88-88-88zm0 128c-22.056 0-40-17.944-40-40s17.944-40 40-40 40 17.944 40 40-17.944 40-40 40z"></path></svg>';

const WRAP_ICON = '<svg stroke="currentColor" fill="none" stroke-width="2" viewBox="0 0 24 24" stroke-linecap="round" stroke-linejoin="round" width="14" height="14" xmlns="http://www.w3.org/2000/svg"><path d="M4 6l16 0"></path><path d="M4 18l5 0"></path><path d="M4 12h13a3 3 0 0 1 0 6h-4l2 -2m0 4l-2 -2"></path></svg>';

const COPY_ICON = '<svg stroke="currentColor" fill="currentColor" stroke-width="0" viewBox="0 0 24 24" width="14" height="14" xmlns="http://www.w3.org/2000/svg"><path d="M16 1H4c-1.1 0-2 .9-2 2v14h2V3h12V1zm3 4H8c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h11c1.1 0 2-.9 2-2V7c0-1.1-.9-2-2-2zm0 16H8V7h11v14z"></path></svg>';

const PREVIEW_ICON = '<svg stroke="currentColor" fill="currentColor" stroke-width="0" viewBox="0 0 24 24" width="14" height="14" xmlns="http://www.w3.org/2000/svg"><path fill="none" d="M0 0h24v24H0z"></path><path d="M19 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14c1.1 0 2-.9 2-2V5a2 2 0 0 0-2-2zm0 16H5V7h14v12zm-5.5-6c0 .83-.67 1.5-1.5 1.5s-1.5-.67-1.5-1.5.67-1.5 1.5-1.5 1.5.67 1.5 1.5zM12 9c-2.73 0-5.06 1.66-6 4 .94 2.34 3.27 4 6 4s5.06-1.66 6-4c-.94-2.34-3.27-4-6-4zm0 6.5a2.5 2.5 0 0 1 0-5 2.5 2.5 0 0 1 0 5z"></path></svg>';

const GOTO_LINE_ICON = '<svg stroke="currentColor" fill="none" stroke-width="2" viewBox="0 0 24 24" stroke-linecap="round" stroke-linejoin="round" width="14" height="14" xmlns="http://www.w3.org/2000/svg"><path d="M14 2v4a2 2 0 0 0 2 2h4"></path><path d="M4.268 21a2 2 0 0 0 1.727 1H18a2 2 0 0 0 2-2V7l-5-5H6a2 2 0 0 0-2 2v3"></path><path d="m9 18-1.5-1.5"></path><circle cx="5" cy="14" r="3"></circle><g stroke="currentColor" stroke-width="1" text-anchor="middle" font-family="monospace" font-size="8"><text x="10" y="10">1</text><text x="14" y="18">2</text></g></svg>';

const CLOSE_ICON = '<svg stroke="currentColor" fill="currentColor" stroke-width="0" viewBox="0 0 512 512" width="14" height="14" xmlns="http://www.w3.org/2000/svg"><path d="M400 145.49 366.51 112 256 222.51 145.49 112 112 145.49 222.51 256 112 366.51 145.49 400 256 289.49 366.51 400 400 366.51 289.49 256 400 145.49z"></path></svg>';

/**
 * Flash a button with a brief color change to indicate success.
 * For icon buttons: flashes green. For text buttons: replaces text temporarily.
 */
function flashButtonText(btn, text, duration = 1200) {
  if (btn.classList.contains('fp-icon-btn')) {
    // Icon button — flash color instead of replacing content
    btn.style.color = '#3ecf5a';
    btn.style.borderColor = 'rgba(62,207,90,0.4)';
    setTimeout(() => { btn.style.color = ''; btn.style.borderColor = ''; }, duration);
  } else {
    const original = btn.innerHTML;
    btn.textContent = text;
    setTimeout(() => { btn.innerHTML = original; }, duration);
  }
}

/**
 * Toggle markdown preview for a viewer.
 */
function toggleMarkdownPreview({ editorEl, previewEl, toggleBtn, editorView, isPreview, storageKey }) {
  if (!isPreview) {
    const content = editorView ? editorView.state.doc.toString() : '';
    previewEl.innerHTML = DOMPurify.sanitize(window.marked.parse(content));
    editorEl.style.display = 'none';
    previewEl.style.display = 'block';
    toggleBtn.classList.add('active');
    toggleBtn.title = 'Back to editor';
    if (storageKey) localStorage.setItem(storageKey, 'true');
    return true;
  } else {
    previewEl.style.display = 'none';
    editorEl.style.display = '';
    toggleBtn.classList.remove('active');
    toggleBtn.title = 'Toggle markdown preview';
    if (storageKey) localStorage.setItem(storageKey, 'false');
    return false;
  }
}

/**
 * Create a viewer toolbar.
 *
 * @param {Object} opts
 * @param {boolean} opts.copyPath     - Show copy-path button
 * @param {boolean} opts.copyContent  - Show copy-content button
 * @param {boolean} opts.preview      - Show preview toggle
 * @param {boolean} opts.wrap         - Show wrap toggle
 * @param {boolean} opts.save         - Show save button
 * @param {boolean} opts.close        - Show close button
 * @param {boolean} opts.diffToggle   - Show diff mode toggle
 *
 * @returns {Object} toolbar API:
 *   .el           - The toolbar DOM element
 *   .titleEl      - Title span
 *   .pathEl       - Path span
 *   .previewBtn   - Preview button (or null)
 *   .wrapBtn      - Wrap button (or null)
 *   .saveBtn      - Save button (or null)
 *   .closeBtn     - Close button (or null)
 *   .copyPathBtn  - Copy path button (or null)
 *   .copyContentBtn - Copy content button (or null)
 *   .diffToggleBtn - Diff toggle button (or null)
 *   .setTitle(text)
 *   .setPath(text)
 *   .setPreviewMode(active)
 *   .setWrapMode(active)
 *   .flashSave()
 *   .on(event, handler)  - Attach event handlers
 */
function createViewerToolbar(opts = {}) {
  const el = document.createElement('div');
  el.className = 'viewer-toolbar';

  const infoEl = document.createElement('div');
  infoEl.className = 'viewer-toolbar-info';

  const titleEl = document.createElement('span');
  titleEl.className = 'viewer-toolbar-title';
  infoEl.appendChild(titleEl);

  const pathEl = document.createElement('span');
  pathEl.className = 'viewer-toolbar-path';
  infoEl.appendChild(pathEl);

  let copyPathBtn = null;
  if (opts.copyPath) {
    copyPathBtn = document.createElement('button');
    copyPathBtn.className = 'viewer-toolbar-copy-path';
    copyPathBtn.title = 'Copy file path';
    copyPathBtn.innerHTML = COPY_ICON;
    infoEl.appendChild(copyPathBtn);
  }

  el.appendChild(infoEl);

  const controlsEl = document.createElement('div');
  controlsEl.className = 'viewer-toolbar-controls';

  let diffToggleBtn = null;
  if (opts.diffToggle) {
    diffToggleBtn = document.createElement('button');
    diffToggleBtn.className = 'fp-toolbar-btn';
    diffToggleBtn.style.display = 'none';
    controlsEl.appendChild(diffToggleBtn);
  }

  let previewBtn = null;
  if (opts.preview) {
    previewBtn = document.createElement('button');
    previewBtn.className = 'fp-toolbar-btn fp-icon-btn';
    previewBtn.innerHTML = PREVIEW_ICON;
    previewBtn.title = 'Toggle markdown preview';
    controlsEl.appendChild(previewBtn);
  }

  let copyContentBtn = null;
  if (opts.copyContent) {
    copyContentBtn = document.createElement('button');
    copyContentBtn.className = 'fp-toolbar-btn fp-icon-btn';
    copyContentBtn.innerHTML = COPY_ICON;
    copyContentBtn.title = 'Copy raw content';
    controlsEl.appendChild(copyContentBtn);
  }

  let wrapBtn = null;
  if (opts.wrap) {
    wrapBtn = document.createElement('button');
    wrapBtn.className = 'fp-toolbar-btn fp-icon-btn';
    wrapBtn.title = 'Toggle line wrapping';
    wrapBtn.innerHTML = WRAP_ICON;
    controlsEl.appendChild(wrapBtn);
  }

  let gotoLineBtn = null;
  if (opts.gotoLine) {
    gotoLineBtn = document.createElement('button');
    gotoLineBtn.className = 'fp-toolbar-btn fp-icon-btn';
    gotoLineBtn.title = 'Go to line (Cmd+G)';
    gotoLineBtn.innerHTML = GOTO_LINE_ICON;
    controlsEl.appendChild(gotoLineBtn);
  }

  let saveBtn = null;
  if (opts.save) {
    saveBtn = document.createElement('button');
    saveBtn.className = 'fp-toolbar-btn fp-save-btn fp-icon-btn';
    saveBtn.title = 'Save changes';
    saveBtn.innerHTML = SAVE_ICON;
    controlsEl.appendChild(saveBtn);
  }

  let closeBtn = null;
  if (opts.close) {
    closeBtn = document.createElement('button');
    closeBtn.className = 'fp-toolbar-btn fp-close-btn fp-icon-btn';
    closeBtn.innerHTML = CLOSE_ICON;
    closeBtn.title = 'Close panel';
    controlsEl.appendChild(closeBtn);
  }

  el.appendChild(controlsEl);

  // API
  const toolbar = {
    el,
    titleEl,
    pathEl,
    previewBtn,
    wrapBtn,
    saveBtn,
    closeBtn,
    copyPathBtn,
    copyContentBtn,
    diffToggleBtn,
    gotoLineBtn,

    setTitle(text) { titleEl.textContent = text; },
    setPath(text) { pathEl.textContent = text; },

    setPreviewMode(active) {
      if (!previewBtn) return;
      previewBtn.classList.toggle('active', active);
      previewBtn.title = active ? 'Back to editor' : 'Toggle markdown preview';
    },

    setWrapMode(active) {
      if (!wrapBtn) return;
      wrapBtn.classList.toggle('active', active);
    },

    flashSave() {
      if (!saveBtn) return;
      flashButtonText(saveBtn, 'Saved!');
    },

    flashCopyPath() {
      if (!copyPathBtn) return;
      flashButtonText(copyPathBtn, '✓', 800);
    },

    flashCopyContent() {
      if (!copyContentBtn) return;
      flashButtonText(copyContentBtn, 'Copied!');
    },
  };

  return toolbar;
}

// Prevent Chromium's default Cmd/Ctrl+S behavior (Save Page)
document.addEventListener('keydown', (e) => {
  const mod = /Mac|iPhone|iPad/.test(navigator.platform) ? e.metaKey : e.ctrlKey;
  if (e.key === 's' && mod && !e.shiftKey && !e.altKey) {
    e.preventDefault();
  }
});

// Expose globally
window.createViewerToolbar = createViewerToolbar;
window.flashButtonText = flashButtonText;
window.toggleMarkdownPreview = toggleMarkdownPreview;
