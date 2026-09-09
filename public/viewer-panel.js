/**
 * viewer-panel.js — Unified viewer component for CodeMirror-based panels.
 *
 * A single component used by plan viewer, memory viewer, and file panel.
 * Manages toolbar, editor, preview area, and all interactions.
 * Watches files for external changes and reloads automatically.
 *
 * Toolbar buttons are shown/hidden automatically based on file type:
 *   - Preview: shown for markdown and HTML files
 *   - Images and PDFs: read-only previews with text editing controls hidden
 *   - Wrap: shown for text (defaults on for markdown, off for others)
 *   - Save: shown if onSave is provided
 *   - Close: shown if onClose is provided
 *   - Copy path/content: shown if opted in
 *
 * Depends on: viewer-toolbar.js, codemirror-bundle.js
 */

class ViewerPanel {
  /**
   * @param {HTMLElement} container - Parent element to render into
   * @param {Object} opts
   * @param {Function}  opts.onSave       - async (filePath, content) => result
   * @param {Function}  opts.onClose      - () => void
   * @param {boolean}   opts.copyPath     - Show copy-path button
   * @param {boolean}   opts.copyContent  - Show copy-content button
   * @param {string}    opts.language     - 'markdown' or 'auto' (default 'markdown')
   * @param {string}    opts.storageKey   - localStorage key for preview mode persistence
   */
  constructor(container, opts = {}) {
    this.container = container;
    this.opts = opts;

    // State
    this.filePath = '';
    this.editorView = null;
    this.previewMode = opts.storageKey ? localStorage.getItem(opts.storageKey) === 'true' : false;
    this.wrapMode = false;
    this._watchedPath = null;
    this._saving = false;
    this.previewType = 'text';
    this._objectUrl = null;
    this._openVersion = 0;

    // Create toolbar — always include preview, wrap, save; visibility managed in open()
    this.toolbar = window.createViewerToolbar({
      copyPath: !!opts.copyPath,
      copyContent: !!opts.copyContent,
      preview: true,
      wrap: true,
      gotoLine: true,
      save: !!opts.onSave,
      close: !!opts.onClose,
    });
    container.insertBefore(this.toolbar.el, container.firstChild);

    // Hide preview initially (shown in open() if markdown)
    if (this.toolbar.previewBtn) this.toolbar.previewBtn.style.display = 'none';

    // Create editor area
    this.editorEl = document.createElement('div');
    this.editorEl.className = 'viewer-panel-editor';
    container.appendChild(this.editorEl);

    // Create preview area
    this.previewEl = document.createElement('div');
    this.previewEl.className = 'markdown-preview';
    this.previewEl.style.display = 'none';
    container.appendChild(this.previewEl);

    // Wire toolbar events
    this._wireEvents();

    // Listen for Cmd/Ctrl+S from CM editors
    container.addEventListener('cm-save', () => this._save());

    // Listen for file changes from main process
    this._onFileChanged = (changedPath) => {
      if (changedPath === this._watchedPath && !this._saving) {
        this._reloadFromDisk();
      }
    };
    if (window.api.onFileChanged) {
      window.api.onFileChanged(this._onFileChanged);
    }
  }

  _wireEvents() {
    const { toolbar, opts } = this;

    if (toolbar.previewBtn) {
      toolbar.previewBtn.addEventListener('click', () => this._togglePreview());
    }

    if (toolbar.wrapBtn) {
      toolbar.wrapBtn.addEventListener('click', () => this._toggleWrap());
    }

    if (toolbar.gotoLineBtn) {
      toolbar.gotoLineBtn.addEventListener('click', () => {
        if (this.editorView && window.cmOpenGotoLine) {
          window.cmOpenGotoLine(this.editorView);
        }
      });
    }

    if (toolbar.saveBtn && opts.onSave) {
      toolbar.saveBtn.addEventListener('click', () => this._save());
    }

    if (toolbar.closeBtn && opts.onClose) {
      toolbar.closeBtn.addEventListener('click', () => opts.onClose());
    }

    if (toolbar.copyPathBtn) {
      toolbar.copyPathBtn.addEventListener('click', () => {
        navigator.clipboard.writeText(this.filePath);
        toolbar.flashCopyPath();
      });
    }

    if (toolbar.copyContentBtn) {
      toolbar.copyContentBtn.addEventListener('click', () => {
        const content = this.getContent();
        navigator.clipboard.writeText(content);
        toolbar.flashCopyContent();
      });
    }
  }

  /**
   * Open a file in the viewer.
   */
  open(title, filePath, content = '', preview = {}) {
    this._unwatchFile();
    this._clearPreview();
    this._openVersion++;

    const previousPath = this.filePath;
    this.filePath = filePath;
    this.previewUrl = preview.previewUrl || '';
    this.previewType = preview.previewType || (/\.html?$/i.test(filePath) ? 'html' : 'text');
    this.toolbar.setTitle(title);
    this.toolbar.setPath(filePath);

    const isMd = this._isMarkdown(filePath);
    const isMedia = this._isMedia();
    const isHtml = this.previewType === 'html';

    // Show/hide preview button based on file type
    if (this.toolbar.previewBtn) {
      this.toolbar.previewBtn.style.display = !isMedia && (isMd || isHtml) ? '' : 'none';
    }
    for (const key of ['wrapBtn', 'gotoLineBtn', 'saveBtn', 'copyContentBtn']) {
      if (this.toolbar[key]) this.toolbar[key].style.display = isMedia ? 'none' : '';
    }

    // Save preview preference before resetting
    const wantPreview = isHtml || (isMd && this.opts.storageKey && localStorage.getItem(this.opts.storageKey) === 'true');

    // Reset to edit mode before updating content (without touching localStorage)
    this.editorEl.style.display = isMedia ? 'none' : '';
    this.previewMode = false;
    this.toolbar.setPreviewMode(false);
    if (this.toolbar.previewBtn) {
      this.toolbar.previewBtn.title = isHtml ? 'Preview HTML' : 'Toggle markdown preview';
      this.toolbar.previewBtn.setAttribute('aria-label', this.toolbar.previewBtn.title);
      this.toolbar.previewBtn.setAttribute('aria-pressed', 'false');
    }

    // Recreate when changing files so language, undo history and search state
    // cannot leak from the previous file into this one.
    if (this.editorView && (previousPath !== filePath || isMedia)) {
      this._destroyEditor();
    }
    this.wrapMode = isMd;
    if (isMedia) {
      const bytes = Uint8Array.from(atob(preview.base64 || ''), char => char.charCodeAt(0));
      this._objectUrl = URL.createObjectURL(new Blob([bytes], { type: preview.mimeType }));
      this.previewMode = true;
      this._renderPreview();
      this._watchFile(filePath);
      return;
    }

    // Create or update editor
    if (!this.editorView) {
      this._createEditor(content, filePath);
    } else {
      this.editorView.dispatch({
        changes: { from: 0, to: this.editorView.state.doc.length, insert: content },
      });
    }

    // Set wrap default based on file type
    this.wrapMode = isMd;
    this.toolbar.setWrapMode(this.wrapMode);
    if (this.editorView && this.editorView._wrapCompartment) {
      this.editorView.dispatch({
        effects: this.editorView._wrapCompartment.reconfigure(
          this.wrapMode ? window.CMEditorView.lineWrapping : []
        ),
      });
    }

    // Re-apply preview preference
    if (wantPreview) {
      this._setPreview(true);
    }

    // Watch for external changes
    this._watchFile(filePath);
  }

  _createEditor(content, filePath) {
    if (this.opts.language === 'auto') {
      this.editorView = window.createEditableViewer(
        this.editorEl, content, filePath, { wrap: this.wrapMode },
      );
    } else {
      this.editorView = window.createPlanEditor(this.editorEl);
      if (content) {
        this.editorView.dispatch({
          changes: { from: 0, to: this.editorView.state.doc.length, insert: content },
        });
      }
    }
  }

  _togglePreview() {
    if (this._isMedia() || (!this._isMarkdown(this.filePath) && this.previewType !== 'html')) return;
    this.previewMode = !this.previewMode;
    if (this.previewMode) this._renderPreview();
    else this._clearPreview();
    this.editorEl.style.display = this.previewMode ? 'none' : '';
    this.toolbar.setPreviewMode(this.previewMode);
    const label = this.previewMode ? 'Back to editor' : this.previewType === 'html' ? 'Preview HTML' : 'Toggle markdown preview';
    this.toolbar.previewBtn.title = label;
    this.toolbar.previewBtn.setAttribute('aria-label', label);
    this.toolbar.previewBtn.setAttribute('aria-pressed', String(this.previewMode));
    if (this._isMarkdown(this.filePath) && this.opts.storageKey) {
      localStorage.setItem(this.opts.storageKey, String(this.previewMode));
    }
  }

  _isMedia() {
    return this.previewType === 'image' || this.previewType === 'pdf';
  }

  _renderPreview() {
    this.previewEl.replaceChildren();
    if (this.previewType === 'image') {
      this.previewEl.className = 'viewer-media-preview viewer-media-preview--image';
      this.previewEl.style.display = 'flex';
      const img = document.createElement('img');
      img.alt = this.filePath.split(/[\\/]/).pop();
      img.onerror = () => {
        const error = document.createElement('div');
        error.className = 'viewer-preview-error';
        error.textContent = 'This image could not be displayed. The file may be damaged or use an unsupported image format.';
        this.previewEl.replaceChildren(error);
      };
      img.src = this._objectUrl;
      this.previewEl.appendChild(img);
    } else if (this.previewType === 'pdf' || this.previewType === 'html') {
      this.previewEl.className = 'viewer-media-preview';
      this.previewEl.style.display = 'block';
      const frame = document.createElement('iframe');
      frame.className = 'viewer-preview-frame';
      frame.title = `${this.previewType === 'pdf' ? 'PDF' : 'HTML'} preview: ${this.filePath.split(/[\\/]/).pop()}`;
      if (this.previewType === 'pdf') {
        // Chromium's built-in PDF viewer provides zoom, page navigation and print.
        frame.src = this._objectUrl;
      } else {
        // Scripts run with an opaque origin: no parent DOM, app APIs or
        // shared storage. Never combine allow-scripts with allow-same-origin.
        frame.setAttribute('sandbox', 'allow-scripts');
        frame.referrerPolicy = 'no-referrer';
        const doc = new DOMParser().parseFromString(this.getContent(), 'text/html');
        const policy = doc.createElement('meta');
        policy.httpEquiv = 'Content-Security-Policy';
        // Only the current asset scope can be fetched. No file:// reads or
        // connections to local app services; CDN scripts/images still work.
        const assetOrigin = /^switchboard-preview:\/\/[a-f0-9]+\//.exec(this.previewUrl)?.[0] || '';
        policy.content = `default-src 'none'; script-src 'unsafe-inline' ${assetOrigin} https: http:; img-src ${assetOrigin} data: blob: https: http:; style-src 'unsafe-inline' ${assetOrigin} https: http:; font-src ${assetOrigin} data: https: http:; connect-src ${assetOrigin || "'none'"}; base-uri ${assetOrigin || "'none'"}; form-action 'none'`;
        if (assetOrigin) {
          const base = doc.createElement('base');
          base.href = this.previewUrl;
          doc.head.prepend(base);
        }
        doc.head.prepend(policy);
        frame.srcdoc = '<!DOCTYPE html>\n' + doc.documentElement.outerHTML;
      }
      this.previewEl.appendChild(frame);
    } else {
      this.previewEl.className = 'markdown-preview';
      this.previewEl.style.display = 'block';
      this.previewEl.innerHTML = window.marked.parse(this.getContent());
    }
  }

  _clearPreview() {
    this.previewEl.replaceChildren();
    this.previewEl.style.display = 'none';
    if (this._objectUrl) URL.revokeObjectURL(this._objectUrl);
    this._objectUrl = null;
  }

  _setPreview(show) {
    if (this.previewMode === show) return;
    this._togglePreview();
  }

  _toggleWrap() {
    if (!this.editorView || !this.editorView._wrapCompartment) return;
    this.wrapMode = !this.wrapMode;
    this.editorView.dispatch({
      effects: this.editorView._wrapCompartment.reconfigure(
        this.wrapMode ? window.CMEditorView.lineWrapping : []
      ),
    });
    this.toolbar.setWrapMode(this.wrapMode);
  }

  async _save() {
    if (!this.opts.onSave || !this.filePath || this._isMedia()) return;
    this._saving = true;
    const content = this.getContent();
    try {
      const result = await this.opts.onSave(this.filePath, content);
      if (result && result.ok !== false) {
        this.toolbar.flashSave();
      }
    } finally {
      setTimeout(() => { this._saving = false; }, 500);
    }
  }

  // Keep the current buffer when its file (or an ancestor folder) is renamed.
  async relocate(title, filePath) {
    this._unwatchFile();
    const version = ++this._openVersion;
    this.filePath = filePath;
    this.toolbar.setTitle(title);
    this.toolbar.setPath(filePath);
    let result;
    try { result = await window.api.readFileForPanel(filePath); } catch {}
    if (version !== this._openVersion) return null;
    if (result?.ok) {
      // A new extension must not discard an editable buffer by switching it
      // to a binary preview. Reopening later uses the new file type normally.
      const preview = this.editorView && ['image', 'pdf'].includes(result.previewType)
        ? { ...result, previewType: 'text' } : result;
      this.open(title, filePath, this.editorView ? this.getContent() : result.content, preview);
    } else {
      this._watchFile(filePath);
    }
    return result;
  }

  getContent() {
    return this.editorView ? this.editorView.state.doc.toString() : '';
  }

  destroy() {
    this._unwatchFile();
    this._openVersion++;
    this._destroyEditor();
    this._clearPreview();
    this.filePath = '';
    this.previewMode = false;
  }

  _destroyEditor() {
    if (this.editorView) {
      this.editorView.destroy();
      this.editorView = null;
    }
    // Clear stale search/goto-line bar references so they get recreated with the new editor
    delete this.editorEl._cmSearchBar;
    delete this.editorEl._cmGotoLine;
    this.editorEl.innerHTML = '';
  }

  // ── File Watching ──────────────────────────────────────────────────

  _watchFile(filePath) {
    if (!filePath || !window.api.watchFile) return;
    this._watchedPath = filePath;
    window.api.watchFile(filePath);
  }

  _unwatchFile() {
    if (this._watchedPath && window.api.unwatchFile) {
      window.api.unwatchFile(this._watchedPath);
      this._watchedPath = null;
    }
  }

  async _reloadFromDisk() {
    if (!this.filePath || !window.api.readFileForPanel) return;
    const version = this._openVersion;
    const result = await window.api.readFileForPanel(this.filePath);
    if (version !== this._openVersion) return;
    if (!result.ok) return;
    if (this._isMedia()) {
      this.open(this.toolbar.titleEl.textContent, this.filePath, result.content, result);
      return;
    }

    const newContent = result.content;
    const currentContent = this.getContent();
    if (newContent === currentContent) return;

    if (this.editorView) {
      this.editorView.dispatch({
        changes: { from: 0, to: this.editorView.state.doc.length, insert: newContent },
      });
    }

    if (this.previewMode) {
      this._renderPreview();
    }
  }

  _isMarkdown(filePath) {
    if (!filePath) return this.opts.language === 'markdown';
    const ext = filePath.split('.').pop()?.toLowerCase();
    return ext === 'md' || ext === 'mdx';
  }
}

window.ViewerPanel = ViewerPanel;
