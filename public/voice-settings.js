// voice-settings.js — wire the voice block in the global Settings panel.
// Renders inside the existing settings dialog when scope === 'global'.

(function () {
  function fmtHotkey(hk) {
    if (!hk) return '';
    const parts = [];
    if (hk.ctrl) parts.push('Ctrl');
    if (hk.shift) parts.push('Shift');
    if (hk.alt) parts.push('Alt');
    parts.push(hk.key || '?');
    return parts.join('+');
  }

  // Capture the next key event into a hotkey object. Used by the "click to
  // bind" inputs in the settings panel.
  function bindHotkey(button, onCapture) {
    const original = button.textContent;
    button.textContent = 'Press a key…';
    button.classList.add('voice-hotkey-binding');
    function handler(ev) {
      // Allow modifier-only PTT keys (e.g. Right Alt).
      ev.preventDefault();
      const isModifierOnly = ['AltLeft', 'AltRight', 'ControlLeft', 'ControlRight', 'ShiftLeft', 'ShiftRight'].includes(ev.code);
      const hk = {
        key: ev.code,
        ctrl: !isModifierOnly && ev.ctrlKey,
        shift: !isModifierOnly && ev.shiftKey,
        alt: !isModifierOnly && ev.altKey,
      };
      window.removeEventListener('keydown', handler, true);
      button.classList.remove('voice-hotkey-binding');
      button.textContent = fmtHotkey(hk);
      onCapture(hk);
    }
    function cancel() {
      window.removeEventListener('keydown', handler, true);
      button.classList.remove('voice-hotkey-binding');
      button.textContent = original;
    }
    window.addEventListener('keydown', handler, true);
    setTimeout(() => {
      // Cancel binding mode if user clicks elsewhere within ~6s.
      const onClick = (ev) => {
        if (ev.target !== button) {
          document.removeEventListener('mousedown', onClick, true);
          cancel();
        }
      };
      document.addEventListener('mousedown', onClick, true);
    }, 0);
  }

  // Build the voice settings sub-panel as a DocumentFragment to be slotted
  // into the global settings viewer.
  async function buildVoicePanel(currentVoice, onSave) {
    const root = document.createElement('div');
    root.className = 'voice-settings';
    const v = Object.assign({
      enabled: true, host: '127.0.0.1', port: 52391, language: 'en', autoSubmit: false,
      hotkeyPtt: { key: 'AltRight' },
      hotkeyToggle: { key: 'Space', ctrl: true, shift: true },
    }, currentVoice || {});

    const headerH = document.createElement('div');
    headerH.className = 'settings-section-title';
    headerH.textContent = 'Voice (local Whisper)';
    root.appendChild(headerH);

    const status = document.createElement('div');
    status.className = 'voice-status-line';
    status.textContent = 'Checking server…';
    root.appendChild(status);

    async function refreshStatus() {
      try {
        const s = await window.api.whisper.status();
        const isReady = s && s.status === 'ready';
        status.classList.toggle('is-ready', !!isReady);
        status.classList.toggle('is-error', s && s.status === 'error');
        let text = `Server: ${s?.status || '?'}`;
        if (s?.endpoint) text += `  ·  ${s.endpoint}`;
        if (s?.managedBy) text += `  ·  ${s.managedBy}`;
        if (s?.modelPath) text += `\nModel: ${s.modelPath}`;
        if (s?.binaryPath) text += `\nBinary: ${s.binaryPath}`;
        if (s?.error) text += `\nError: ${s.error}`;
        status.textContent = text;
      } catch { status.textContent = 'Server: unknown'; }
    }
    refreshStatus();
    if (window.api && window.api.whisper && window.api.whisper.onState) {
      window.api.whisper.onState(() => refreshStatus());
    }

    function field(label, desc, control) {
      const f = document.createElement('div');
      f.className = 'settings-field settings-field-wide';
      const info = document.createElement('div'); info.className = 'settings-field-info';
      const lbl = document.createElement('span'); lbl.className = 'settings-label'; lbl.textContent = label;
      const d = document.createElement('div'); d.className = 'settings-description'; d.textContent = desc;
      info.appendChild(lbl); info.appendChild(d);
      const wrap = document.createElement('div'); wrap.className = 'settings-field-control'; wrap.appendChild(control);
      f.appendChild(info); f.appendChild(wrap);
      return f;
    }

    // Enabled
    const enabledIn = document.createElement('input'); enabledIn.type = 'checkbox'; enabledIn.checked = !!v.enabled;
    const enabledLbl = document.createElement('label'); enabledLbl.className = 'settings-toggle';
    const enabledSlider = document.createElement('span'); enabledSlider.className = 'settings-toggle-slider';
    enabledLbl.appendChild(enabledIn); enabledLbl.appendChild(enabledSlider);
    root.appendChild(field('Enable voice', 'Listen for hotkeys, record, transcribe via local whisper-server.', enabledLbl));

    // Host + port
    const hostIn = document.createElement('input'); hostIn.className = 'settings-input'; hostIn.style.width = '160px'; hostIn.value = v.host;
    const portIn = document.createElement('input'); portIn.className = 'settings-input'; portIn.type = 'number'; portIn.style.width = '90px'; portIn.value = String(v.port);
    const hp = document.createElement('div'); hp.style.display = 'flex'; hp.style.gap = '6px';
    hp.appendChild(hostIn); hp.appendChild(portIn);
    root.appendChild(field('Server host / port', '127.0.0.1 + a unique port (default 52391).', hp));

    // Language
    const langIn = document.createElement('input'); langIn.className = 'settings-input'; langIn.style.width = '90px'; langIn.value = v.language;
    root.appendChild(field('Language', 'ISO-639-1 (e.g. en, de). Use "auto" to autodetect.', langIn));

    // Auto-submit
    const autoIn = document.createElement('input'); autoIn.type = 'checkbox'; autoIn.checked = !!v.autoSubmit;
    const autoLbl = document.createElement('label'); autoLbl.className = 'settings-toggle';
    const autoSlider = document.createElement('span'); autoSlider.className = 'settings-toggle-slider';
    autoLbl.appendChild(autoIn); autoLbl.appendChild(autoSlider);
    root.appendChild(field('Auto-submit', 'Append Enter after inserting transcript (skips manual review).', autoLbl));

    // Hotkeys
    let pttHk = v.hotkeyPtt;
    let togHk = v.hotkeyToggle;
    const pttBtn = document.createElement('button'); pttBtn.className = 'voice-hotkey-btn'; pttBtn.type = 'button'; pttBtn.textContent = fmtHotkey(pttHk);
    pttBtn.onclick = () => bindHotkey(pttBtn, (hk) => { pttHk = hk; });
    root.appendChild(field('Push-to-talk hotkey', 'Hold to record, release to transcribe + insert.', pttBtn));
    const togBtn = document.createElement('button'); togBtn.className = 'voice-hotkey-btn'; togBtn.type = 'button'; togBtn.textContent = fmtHotkey(togHk);
    togBtn.onclick = () => bindHotkey(togBtn, (hk) => { togHk = hk; });
    root.appendChild(field('Toggle hotkey', 'First press starts, second press stops + transcribes.', togBtn));

    // Server lifecycle controls
    const ctrls = document.createElement('div'); ctrls.className = 'voice-server-controls';
    const startBtn = document.createElement('button'); startBtn.className = 'voice-srv-btn'; startBtn.type = 'button'; startBtn.textContent = 'Start';
    const stopBtn = document.createElement('button'); stopBtn.className = 'voice-srv-btn'; stopBtn.type = 'button'; stopBtn.textContent = 'Stop';
    const restartBtn = document.createElement('button'); restartBtn.className = 'voice-srv-btn'; restartBtn.type = 'button'; restartBtn.textContent = 'Restart';
    startBtn.onclick = () => window.api.whisper.start().then(() => refreshStatus());
    stopBtn.onclick = () => window.api.whisper.stop().then(() => refreshStatus());
    restartBtn.onclick = () => window.api.whisper.restart().then(() => refreshStatus());
    const pingBtn = document.createElement('button'); pingBtn.className = 'voice-srv-btn'; pingBtn.type = 'button'; pingBtn.textContent = 'Ping';
    const pingOut = document.createElement('span'); pingOut.className = 'voice-task-status';
    pingBtn.onclick = async () => {
      pingBtn.disabled = true;
      pingOut.classList.remove('is-error');
      pingOut.textContent = 'Pinging…';
      try {
        const r = await window.api.whisper.ping();
        pingOut.textContent = r.ok ? `Reachable at ${r.endpoint}` : `Unreachable at ${r.endpoint} — server not running on configured port`;
        pingOut.classList.toggle('is-error', !r.ok);
      } catch (err) {
        pingOut.textContent = 'Ping failed: ' + (err.message || err);
        pingOut.classList.add('is-error');
      } finally { pingBtn.disabled = false; }
    };
    ctrls.appendChild(startBtn); ctrls.appendChild(stopBtn); ctrls.appendChild(restartBtn); ctrls.appendChild(pingBtn); ctrls.appendChild(pingOut);
    root.appendChild(field('Server', 'Manage + diagnose the whisper-server child process. "Ping" reports whether the configured port is reachable.', ctrls));

    // Diagnostic — record 3s, transcribe, show result. Bypasses the hotkey
    // path so you can isolate audio/whisper from keyboard issues.
    const testWrap = document.createElement('div'); testWrap.className = 'voice-server-controls';
    const testBtn = document.createElement('button'); testBtn.className = 'voice-srv-btn'; testBtn.type = 'button';
    testBtn.textContent = 'Test microphone (3s)';
    const testOut = document.createElement('span'); testOut.className = 'voice-task-status';
    testBtn.onclick = async () => {
      if (!window.voice || typeof window.voice.testTranscribe !== 'function') {
        testOut.textContent = 'voice module not loaded'; testOut.classList.add('is-error'); return;
      }
      testBtn.disabled = true;
      testOut.classList.remove('is-error');
      testOut.textContent = 'Recording 3s…';
      const r = await window.voice.testTranscribe(3000);
      testBtn.disabled = false;
      if (r.ok) {
        testOut.textContent = r.transcript ? `OK: "${r.transcript}"` : 'OK but no speech detected';
        testOut.classList.toggle('is-error', !r.transcript);
      } else {
        testOut.textContent = `Failed: ${r.error}`;
        testOut.classList.add('is-error');
      }
    };
    testWrap.appendChild(testBtn); testWrap.appendChild(testOut);
    root.appendChild(field('Test transcription', 'Click → speak for 3 seconds → see what whisper transcribes. Bypasses the hotkey, so this isolates microphone + whisper from keyboard issues.', testWrap));

    // Log path display — voice events (recorded / wav-encoded / transcript /
    // inject ok|failed) are mirrored to the main electron-log file so they
    // can be tailed/inspected when DevTools won't open. Each line is tagged
    // [renderer] [voice] <event> {…json…}.
    const logWrap = document.createElement('div'); logWrap.className = 'voice-server-controls'; logWrap.style.flexWrap = 'wrap';
    const logPath = document.createElement('code');
    logPath.style.fontSize = '11px';
    logPath.style.userSelect = 'all';
    logPath.textContent = 'resolving…';
    if (window.api && typeof window.api.getLogPath === 'function') {
      window.api.getLogPath().then(p => { logPath.textContent = p || '(unavailable)'; }).catch(() => { logPath.textContent = '(unavailable)'; });
    } else {
      logPath.textContent = '(getLogPath not available — restart Switchboard to load the new IPC)';
    }
    const copyBtn = document.createElement('button'); copyBtn.className = 'voice-srv-btn'; copyBtn.type = 'button'; copyBtn.textContent = 'Copy path';
    copyBtn.onclick = async () => {
      try { await navigator.clipboard.writeText(logPath.textContent); copyBtn.textContent = 'Copied'; setTimeout(() => { copyBtn.textContent = 'Copy path'; }, 1500); } catch {}
    };
    logWrap.appendChild(logPath);
    logWrap.appendChild(copyBtn);
    root.appendChild(field('Log file (on disk)', 'Voice diagnostics — recording length, transcript size, inject result, errors — are written here. Open it in any text editor for a post-mortem when something doesn\'t work.', logWrap));

    // Save handler exposed to caller — invoked from the dialog's Save button.
    onSave.collect = () => ({
      enabled: enabledIn.checked,
      host: hostIn.value.trim() || '127.0.0.1',
      port: parseInt(portIn.value, 10) || 52391,
      language: langIn.value.trim() || 'en',
      autoSubmit: autoIn.checked,
      hotkeyPtt: pttHk,
      hotkeyToggle: togHk,
    });

    return root;
  }

  window.buildVoicePanel = buildVoicePanel;
})();
