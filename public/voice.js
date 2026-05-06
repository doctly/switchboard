// voice.js — speech-to-text via local whisper.cpp/server.
//
// Two recording modes:
//   PTT: hold a hotkey (default Right Alt). On keydown → start; on keyup
//        → stop + transcribe + insert at cursor in the active terminal.
//   TOGGLE: press a hotkey (default Ctrl+Shift+Space). First press →
//        start; second → stop + transcribe + insert. Recording survives
//        Alt-Tab and minimise; the hotkey is only active when Switchboard
//        window is focused so we don't fight other apps.
//
// Audio: MediaRecorder → WebM/Opus → AudioContext.decodeAudioData →
// 16-bit PCM mono 16 kHz WAV → POST to whisper-server's /inference
// endpoint as multipart/form-data with field name "file".
//
// Transcript is inserted via the existing `sendInput` IPC, identical to
// typing. No auto-submit by default — the user presses Enter when ready.

(function () {
  const DEFAULT_PORT = 52391;
  const DEFAULT_HOST = '127.0.0.1';
  const DEFAULT_HOTKEY_PTT = { key: 'AltRight' };       // KeyboardEvent.code
  const DEFAULT_HOTKEY_TOGGLE = { key: 'Space', ctrl: true, shift: true };
  const TARGET_SAMPLE_RATE = 16000;  // whisper expects 16k mono
  const MIN_RECORDING_MS = 250;       // ignore accidental taps

  let _settings = {
    enabled: true,
    host: DEFAULT_HOST,
    port: DEFAULT_PORT,
    language: 'en',                   // pass to whisper for accuracy/speed
    autoSubmit: false,                // append \n after insert
    hotkeyPtt: DEFAULT_HOTKEY_PTT,
    hotkeyToggle: DEFAULT_HOTKEY_TOGGLE,
  };
  let _serverState = { status: 'stopped', endpoint: null, error: null };
  let _state = {
    mode: 'idle',         // 'idle' | 'recording-ptt' | 'recording-toggle' | 'transcribing'
    pttKeyHeld: false,
    recorder: null,
    chunks: [],
    startedAt: 0,
    indicator: null,
    levelTimer: null,
    audioContext: null,
    audioSource: null,
    audioAnalyser: null,
    stream: null,
  };

  // ── Hotkey matching ────────────────────────────────────────────────────
  const ALT_CODES = ['AltLeft', 'AltRight'];
  const CTRL_CODES = ['ControlLeft', 'ControlRight'];
  const SHIFT_CODES = ['ShiftLeft', 'ShiftRight'];
  const META_CODES = ['MetaLeft', 'MetaRight'];

  function matches(ev, hk) {
    if (!hk || !hk.key) return false;
    if (ev.code !== hk.key && ev.key !== hk.key) return false;
    // When the hotkey IS a bare modifier (AltRight, etc.), pressing that key
    // intrinsically sets the corresponding ev.<modifier>Key flag — even
    // though no *additional* modifier is held. Skip the strict modifier
    // check for the family the hotkey itself belongs to.
    const hkIsAlt = ALT_CODES.includes(hk.key);
    const hkIsCtrl = CTRL_CODES.includes(hk.key);
    const hkIsShift = SHIFT_CODES.includes(hk.key);
    const hkIsMeta = META_CODES.includes(hk.key);
    // AltGr keyboards (UK, EU layouts) synthesise *both* ctrlKey and
    // altKey when AltRight is pressed. Treat ctrlKey as don't-care for
    // AltRight specifically so the hotkey isn't silently rejected by
    // the AltGr-induced ctrlKey flag.
    const isAltRightHotkey = hk.key === 'AltRight';
    if (!hkIsCtrl && !hkIsMeta && !isAltRightHotkey && (!!hk.ctrl) !== (ev.ctrlKey || ev.metaKey)) return false;
    if (!hkIsShift && (!!hk.shift) !== ev.shiftKey) return false;
    if (!hkIsAlt && (!!hk.alt) !== ev.altKey) return false;
    return true;
  }
  function isModifierKey(ev) {
    return ALT_CODES.includes(ev.code) || CTRL_CODES.includes(ev.code) ||
           SHIFT_CODES.includes(ev.code) || META_CODES.includes(ev.code);
  }

  // ── Indicator UI ───────────────────────────────────────────────────────
  function ensureIndicator() {
    if (_state.indicator) return _state.indicator;
    const el = document.createElement('div');
    el.className = 'voice-indicator';
    el.innerHTML =
      '<span class="voice-dot"></span>' +
      '<span class="voice-status">Listening</span>' +
      '<span class="voice-meter"><span class="voice-meter-fill"></span></span>' +
      '<span class="voice-hint"></span>';
    document.body.appendChild(el);
    _state.indicator = el;
    return el;
  }
  function showIndicator(text, hint, kind) {
    const el = ensureIndicator();
    el.classList.remove('voice-recording', 'voice-transcribing', 'voice-error');
    if (kind) el.classList.add('voice-' + kind);
    el.querySelector('.voice-status').textContent = text || '';
    el.querySelector('.voice-hint').textContent = hint || '';
    el.style.display = 'flex';
  }
  function hideIndicator() {
    if (_state.indicator) _state.indicator.style.display = 'none';
  }
  function setMeter(level01) {
    if (!_state.indicator) return;
    const fill = _state.indicator.querySelector('.voice-meter-fill');
    if (fill) fill.style.width = (Math.min(1, Math.max(0, level01)) * 100).toFixed(1) + '%';
  }

  function startLevelLoop() {
    if (!_state.audioAnalyser) return;
    const buf = new Uint8Array(_state.audioAnalyser.frequencyBinCount);
    const tick = () => {
      if (!_state.audioAnalyser) return;
      _state.audioAnalyser.getByteTimeDomainData(buf);
      let sum = 0;
      for (let i = 0; i < buf.length; i++) {
        const v = (buf[i] - 128) / 128;
        sum += v * v;
      }
      const rms = Math.sqrt(sum / buf.length);
      // Map RMS roughly to 0..1, with a floor so silent rooms don't look dead.
      setMeter(Math.min(1, rms * 4));
      _state.levelTimer = requestAnimationFrame(tick);
    };
    _state.levelTimer = requestAnimationFrame(tick);
  }
  function stopLevelLoop() {
    if (_state.levelTimer) cancelAnimationFrame(_state.levelTimer);
    _state.levelTimer = null;
  }

  // ── Recording ──────────────────────────────────────────────────────────
  async function startRecording() {
    if (!_settings.enabled) {
      showIndicator('Voice disabled', 'Enable in Global Settings → Voice', 'error');
      setTimeout(hideIndicator, 1800);
      return false;
    }
    if (_serverState.status !== 'ready') {
      showIndicator('Whisper not ready', _serverState.error || 'Starting up…', 'error');
      setTimeout(hideIndicator, 2400);
      return false;
    }
    // NOTE: callers gate on _state.mode === 'idle' BEFORE flipping mode and
    // then calling us — so by the time we run, mode is already 'recording-*'.
    // The previous check `if (_state.mode !== 'idle') return false` therefore
    // always tripped and silently rejected every record attempt.

    let stream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, channelCount: 1 },
      });
    } catch (err) {
      showIndicator('Microphone blocked', err.message, 'error');
      setTimeout(hideIndicator, 2400);
      return false;
    }
    _state.stream = stream;

    // Audio analyser for the level meter (parallel to the recorder).
    try {
      const Ctor = window.AudioContext || window.webkitAudioContext;
      const ac = new Ctor();
      const src = ac.createMediaStreamSource(stream);
      const ana = ac.createAnalyser();
      ana.fftSize = 1024;
      src.connect(ana);
      _state.audioContext = ac;
      _state.audioSource = src;
      _state.audioAnalyser = ana;
    } catch {}

    const mimeType = pickRecorderMime();
    const recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
    _state.recorder = recorder;
    _state.chunks = [];
    recorder.ondataavailable = (e) => { if (e.data && e.data.size > 0) _state.chunks.push(e.data); };
    recorder.start(250);   // emit chunks every 250ms; helps if user records long
    _state.startedAt = Date.now();

    showIndicator('Listening', 'Speak now', 'recording');
    startLevelLoop();
    return true;
  }

  function pickRecorderMime() {
    const candidates = ['audio/webm;codecs=opus', 'audio/webm', 'audio/ogg;codecs=opus'];
    for (const m of candidates) {
      try { if (MediaRecorder.isTypeSupported(m)) return m; } catch {}
    }
    return null;
  }

  function teardownRecording() {
    stopLevelLoop();
    if (_state.recorder) {
      try { _state.recorder.stop(); } catch {}
      _state.recorder = null;
    }
    if (_state.stream) {
      try { _state.stream.getTracks().forEach(t => t.stop()); } catch {}
      _state.stream = null;
    }
    if (_state.audioContext) {
      try { _state.audioContext.close(); } catch {}
      _state.audioContext = null;
      _state.audioSource = null;
      _state.audioAnalyser = null;
    }
  }

  async function stopAndTranscribe() {
    if (!_state.recorder || _state.mode === 'transcribing' || _state.mode === 'idle') return;
    const recorder = _state.recorder;
    const elapsed = Date.now() - _state.startedAt;
    const chunks = _state.chunks;
    const stoppedPromise = new Promise((resolve) => { recorder.onstop = resolve; });
    try { recorder.stop(); } catch {}
    await stoppedPromise;

    teardownRecording();

    if (elapsed < MIN_RECORDING_MS) {
      showIndicator('Too short', 'Hold longer', 'error');
      setTimeout(hideIndicator, 1200);
      _state.mode = 'idle';
      return;
    }

    _state.mode = 'transcribing';
    showIndicator('Transcribing…', '', 'transcribing');

    try {
      const opusBlob = new Blob(chunks, { type: chunks[0]?.type || 'audio/webm' });
      console.info('[voice] recorded', { ms: elapsed, bytes: opusBlob.size, mime: opusBlob.type });
      const wavBlob = await opusToWav(opusBlob, TARGET_SAMPLE_RATE);
      console.info('[voice] wav-encoded', { bytes: wavBlob.size });
      const text = await transcribe(wavBlob);
      const trimmed = (text || '').trim();
      console.info('[voice] transcript', { len: trimmed.length, preview: trimmed.slice(0, 80) });
      if (!trimmed) {
        showIndicator('No speech detected', 'Try again, or speak louder', 'error');
        setTimeout(hideIndicator, 2500);
      } else {
        // Visible confirmation that we got a transcript and where it went.
        const sid = window.activeSessionId || sessionStorage.getItem('activeSessionId');
        if (!sid) {
          showIndicator('No active session', 'Open a Claude session first, then try again', 'error');
          setTimeout(hideIndicator, 4000);
        } else {
          const result = await injectText(trimmed, _settings.autoSubmit);
          if (result && result.ok) {
            // Brief preview so the user sees what was injected.
            showIndicator('Inserted', trimmed.length > 60 ? trimmed.slice(0, 57) + '…' : trimmed);
            setTimeout(hideIndicator, 1800);
          } else {
            showIndicator('Insert failed', (result && result.error) || 'sendInput unavailable', 'error');
            setTimeout(hideIndicator, 4000);
          }
        }
      }
    } catch (err) {
      console.error('[voice] transcription failed', err);
      showIndicator('Transcription failed', err.message || String(err), 'error');
      setTimeout(hideIndicator, 3500);
    } finally {
      _state.mode = 'idle';
    }
  }

  // ── Opus → 16 kHz mono WAV ─────────────────────────────────────────────
  async function opusToWav(blob, targetSampleRate) {
    const arrayBuf = await blob.arrayBuffer();
    const Ctor = window.AudioContext || window.webkitAudioContext;
    // OfflineAudioContext gives us deterministic resampling without playing audio.
    const probe = new Ctor();
    let decoded;
    try { decoded = await probe.decodeAudioData(arrayBuf.slice(0)); }
    finally { try { probe.close(); } catch {} }

    const offlineLength = Math.ceil(decoded.duration * targetSampleRate);
    const offline = new OfflineAudioContext(1, offlineLength, targetSampleRate);
    const src = offline.createBufferSource();
    src.buffer = decoded;
    // Sum stereo → mono by going through a 1-channel destination.
    const merger = offline.createChannelMerger(1);
    src.connect(merger);
    merger.connect(offline.destination);
    src.start(0);
    const rendered = await offline.startRendering();
    const pcm16 = float32ToPcm16(rendered.getChannelData(0));
    const wav = encodeWav(pcm16, targetSampleRate);
    return new Blob([wav], { type: 'audio/wav' });
  }

  function float32ToPcm16(f32) {
    const out = new Int16Array(f32.length);
    for (let i = 0; i < f32.length; i++) {
      const s = Math.max(-1, Math.min(1, f32[i]));
      out[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
    }
    return out;
  }

  function encodeWav(pcm16, sampleRate) {
    const dataLen = pcm16.length * 2;
    const buf = new ArrayBuffer(44 + dataLen);
    const v = new DataView(buf);
    let p = 0;
    function w8(s) { for (let i = 0; i < s.length; i++) v.setUint8(p++, s.charCodeAt(i)); }
    function w32(n) { v.setUint32(p, n, true); p += 4; }
    function w16(n) { v.setUint16(p, n, true); p += 2; }
    w8('RIFF'); w32(36 + dataLen); w8('WAVE');
    w8('fmt '); w32(16); w16(1); w16(1); w32(sampleRate); w32(sampleRate * 2); w16(2); w16(16);
    w8('data'); w32(dataLen);
    for (let i = 0; i < pcm16.length; i++) { v.setInt16(p, pcm16[i], true); p += 2; }
    return new Uint8Array(buf);
  }

  // ── Transcription ──────────────────────────────────────────────────────
  // whisper.cpp's `text` response field joins internal VAD segments with
  // newlines. Those segments are an artefact of how whisper chunks audio
  // (pause detection / fixed windows), not user-meaningful linebreaks —
  // and a literal \n landing in the terminal acts as Enter, fragmenting
  // the prompt into multiple submitted lines. Collapse all whitespace
  // runs (newlines, tabs, repeated spaces) to single spaces so a single
  // utterance comes through as one continuous string.
  function flattenWhitespace(s) {
    return String(s || '').replace(/\s+/g, ' ').trim();
  }

  async function transcribe(wavBlob) {
    const endpoint = `http://${_settings.host}:${_settings.port}/inference`;
    const fd = new FormData();
    fd.append('file', wavBlob, 'audio.wav');
    if (_settings.language) fd.append('language', _settings.language);
    fd.append('response_format', 'json');
    fd.append('temperature', '0');
    const res = await fetch(endpoint, { method: 'POST', body: fd });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`HTTP ${res.status} — ${body.slice(0, 160)}`);
    }
    const data = await res.json();
    const raw = (typeof data.text === 'string') ? data.text : (data.transcription || data.transcript || '');
    return flattenWhitespace(raw);
  }

  // ── Inject into the active terminal ────────────────────────────────────
  async function injectText(text, autoSubmit) {
    const sid = window.activeSessionId || sessionStorage.getItem('activeSessionId');
    if (!sid) {
      console.warn('[voice] inject skipped — no active session id in window/sessionStorage');
      return { ok: false, error: 'no active session' };
    }
    if (!(window.api && window.api.sendInput)) {
      console.error('[voice] inject failed — window.api.sendInput is unavailable');
      return { ok: false, error: 'sendInput unavailable' };
    }
    try {
      window.api.sendInput(sid, text);
      if (autoSubmit) window.api.sendInput(sid, '\r');
      console.info('[voice] inject ok', { sid, autoSubmit });
      return { ok: true };
    } catch (err) {
      console.error('[voice] inject threw', err);
      return { ok: false, error: err.message || String(err) };
    }
  }

  // ── State machine entrypoints ──────────────────────────────────────────
  async function onPttDown() {
    if (_state.mode !== 'idle') return;
    _state.mode = 'recording-ptt';
    const ok = await startRecording();
    if (!ok) _state.mode = 'idle';
  }
  async function onPttUp() {
    if (_state.mode !== 'recording-ptt') return;
    await stopAndTranscribe();
  }
  async function onToggle() {
    if (_state.mode === 'recording-toggle') {
      await stopAndTranscribe();
      return;
    }
    if (_state.mode !== 'idle') return;
    _state.mode = 'recording-toggle';
    const ok = await startRecording();
    if (!ok) _state.mode = 'idle';
    else showIndicator('Listening (toggle)', 'Press toggle hotkey again to stop', 'recording');
  }

  // ── Settings hookup ────────────────────────────────────────────────────
  async function refreshSettings() {
    try {
      const global = (await window.api.getSetting('global')) || {};
      const v = global.voice || {};
      _settings = {
        enabled: v.enabled !== false,
        host: v.host || DEFAULT_HOST,
        port: v.port || DEFAULT_PORT,
        language: v.language || 'en',
        autoSubmit: !!v.autoSubmit,
        hotkeyPtt: v.hotkeyPtt || DEFAULT_HOTKEY_PTT,
        hotkeyToggle: v.hotkeyToggle || DEFAULT_HOTKEY_TOGGLE,
      };
    } catch {}
  }

  // ── Event wiring ───────────────────────────────────────────────────────
  function attach() {
    console.info('[voice] module loaded, attaching listeners');
    refreshSettings().then(() => {
      console.info('[voice] settings loaded', {
        enabled: _settings.enabled,
        ptt: _settings.hotkeyPtt,
        toggle: _settings.hotkeyToggle,
        endpoint: `http://${_settings.host}:${_settings.port}`,
      });
    });
    window.addEventListener('keydown', (ev) => {
      if (!_settings.enabled) return;
      if (ev.repeat) return;
      // PTT down (only fires once because of repeat-guard above).
      if (matches(ev, _settings.hotkeyPtt) && !_state.pttKeyHeld) {
        _state.pttKeyHeld = true;
        ev.preventDefault();
        onPttDown();
        return;
      }
      // Toggle hotkey.
      if (matches(ev, _settings.hotkeyToggle)) {
        ev.preventDefault();
        onToggle();
        return;
      }
    }, true);
    window.addEventListener('keyup', (ev) => {
      if (!_settings.enabled) return;
      // Treat any release of the PTT key (or its modifier sibling) as up.
      if (_state.pttKeyHeld && (matches(ev, _settings.hotkeyPtt) || isModifierKey(ev))) {
        _state.pttKeyHeld = false;
        if (_state.mode === 'recording-ptt') onPttUp();
      }
    }, true);

    // Server state via main process.
    if (window.api && window.api.whisper) {
      window.api.whisper.status().then((s) => { _serverState = s || _serverState; });
      window.api.whisper.onState((s) => { _serverState = s || _serverState; });
    }
  }

  // Public API for the settings panel + manual triggers.
  // testTranscribe records for ~3s, runs transcription, and resolves to
  // a {ok, transcript|error} for the settings test button — bypasses the
  // hotkey path entirely so you can isolate audio/whisper from keyboard.
  async function testTranscribe(durationMs) {
    if (_state.mode !== 'idle') return { ok: false, error: 'busy' };
    _state.mode = 'recording-toggle';
    const ok = await startRecording();
    if (!ok) {
      _state.mode = 'idle';
      return { ok: false, error: 'startRecording failed (see console)' };
    }
    await new Promise(r => setTimeout(r, Math.max(500, durationMs || 3000)));
    // stopAndTranscribe drives the rest; report based on indicator state.
    return new Promise((resolve) => {
      const wrap = async () => {
        const startedAt = Date.now();
        // Mirror the stop+transcribe path but capture the result here.
        const recorder = _state.recorder;
        if (!recorder) { _state.mode = 'idle'; resolve({ ok: false, error: 'no recorder' }); return; }
        const chunks = _state.chunks;
        const stoppedPromise = new Promise((r) => { recorder.onstop = r; });
        try { recorder.stop(); } catch {}
        await stoppedPromise;
        teardownRecording();
        _state.mode = 'transcribing';
        showIndicator('Transcribing test…', '', 'transcribing');
        try {
          const opusBlob = new Blob(chunks, { type: chunks[0]?.type || 'audio/webm' });
          const wavBlob = await opusToWav(opusBlob, TARGET_SAMPLE_RATE);
          const text = await transcribe(wavBlob);
          const trimmed = (text || '').trim();
          showIndicator('Test result', trimmed || '(empty)', trimmed ? null : 'error');
          setTimeout(hideIndicator, 4000);
          _state.mode = 'idle';
          resolve({ ok: true, transcript: trimmed, durationMs: Date.now() - startedAt });
        } catch (err) {
          showIndicator('Test failed', err.message || String(err), 'error');
          setTimeout(hideIndicator, 4000);
          _state.mode = 'idle';
          resolve({ ok: false, error: err.message || String(err) });
        }
      };
      wrap();
    });
  }

  window.voice = {
    refreshSettings,
    onPttDown, onPttUp, onToggle,
    testTranscribe,
    getServerState: () => _serverState,
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', attach, { once: true });
  } else {
    attach();
  }
})();
