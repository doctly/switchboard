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
// Audio: AudioWorklet captures raw Float32 mono PCM directly from the
// MediaStreamSource → resample to 16 kHz via OfflineAudioContext → 16-bit
// PCM WAV → save to disk (belt-and-braces) → POST to whisper-server's
// /inference endpoint as multipart/form-data with field name "file".
// We deliberately avoid MediaRecorder: WebM/Opus + decodeAudioData has
// a long tail of silent-truncation failure modes for long dictations.
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
  // Architecture: MediaRecorder produces Opus/WebM chunks every ~2s. Each
  // chunk's bytes are forwarded to the main process via IPC, which appends
  // them to a temp file in <userData>/voice-tmp/. On stop, main hands the
  // file to whisper-server (--convert flag wraps ffmpeg server-side to
  // decode Opus → WAV), gets the transcript back, returns it.
  //
  // Why not AudioWorklet: worklet→main IPC has a queue with a limited
  // depth. Under main-thread load (scrolling, layout, GC) messages get
  // dropped silently → audio with random gaps → "..ifferent" artifacts in
  // long dictations. MediaRecorder runs in browser-internal threads off
  // the main thread entirely, produces fewer/larger chunks, and the
  // codec encoder doesn't drop frames the way the worklet IPC does.
  //
  // Why not in-renderer decode: AudioContext.decodeAudioData on long Opus
  // streams has its own silent-truncation tail. Skipping that path
  // entirely — the file goes straight to whisper-server — is the
  // simplest robust answer.
  //
  // Audio level meter still uses an AudioContext+AnalyserNode parallel
  // to the recorder; the meter has no functional role beyond UX so a
  // jank hiccup there is harmless.

  const MEDIA_RECORDER_CHUNK_MS = 2000;  // emit chunks every 2s

  function pickRecorderMime() {
    const candidates = [
      'audio/webm;codecs=opus',
      'audio/webm',
      'audio/ogg;codecs=opus',
      'audio/mp4',
    ];
    for (const m of candidates) {
      try { if (typeof MediaRecorder !== 'undefined' && MediaRecorder.isTypeSupported(m)) return m; } catch {}
    }
    return null;
  }

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
    if (!(window.api && window.api.voiceRecord)) {
      showIndicator('Voice IPC unavailable', 'Restart Switchboard to load the latest preload', 'error');
      setTimeout(hideIndicator, 4000);
      return false;
    }

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

    // Open the recording file in main *first* — if the IPC fails we'd
    // rather know before we start capturing audio that has nowhere to go.
    let recStart;
    try {
      recStart = await window.api.voiceRecord.start();
    } catch (err) {
      showIndicator('Recorder init failed', err.message || String(err), 'error');
      setTimeout(hideIndicator, 3000);
      try { stream.getTracks().forEach(t => t.stop()); } catch {}
      _state.stream = null;
      return false;
    }
    if (!recStart || !recStart.ok) {
      showIndicator('Recorder init failed', (recStart && recStart.error) || 'unknown', 'error');
      setTimeout(hideIndicator, 3000);
      try { stream.getTracks().forEach(t => t.stop()); } catch {}
      _state.stream = null;
      return false;
    }
    _state.recordingId = recStart.recordingId;
    _state.recordingPath = recStart.path;
    logVoice('info', 'record-start', { recordingId: recStart.recordingId, path: recStart.path });

    // Audio analyser for the level meter — completely parallel to the
    // recorder. If this fails the meter just doesn't move; recording
    // still works.
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

    // MediaRecorder fires `dataavailable` with each container-level chunk.
    // We forward the chunk's bytes to main immediately — main appends to
    // the open file. No accumulation in renderer memory.
    const mimeType = pickRecorderMime();
    let recorder;
    try {
      recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
    } catch (err) {
      logVoice('error', 'mediarecorder-init-failed', { error: err.message || String(err) });
      showIndicator('Recorder init failed', err.message || String(err), 'error');
      setTimeout(hideIndicator, 3000);
      try { stream.getTracks().forEach(t => t.stop()); } catch {}
      _state.stream = null;
      try { await window.api.voiceRecord.cancel(_state.recordingId); } catch {}
      _state.recordingId = null;
      return false;
    }
    _state.recorder = recorder;
    _state.recorderMime = recorder.mimeType || mimeType || 'audio/webm';
    _state.chunksReceived = 0;
    _state.bytesReceived = 0;

    recorder.ondataavailable = async (e) => {
      if (!e || !e.data || !e.data.size) return;
      try {
        const buf = new Uint8Array(await e.data.arrayBuffer());
        _state.chunksReceived += 1;
        _state.bytesReceived += buf.byteLength;
        if (_state.recordingId) {
          window.api.voiceRecord.chunk(_state.recordingId, buf);
        }
      } catch (err) {
        logVoice('warn', 'chunk-forward-failed', { error: err.message || String(err) });
      }
    };
    recorder.onerror = (ev) => {
      logVoice('error', 'recorder-error', { error: (ev && ev.error && ev.error.message) || 'unknown' });
    };

    try {
      recorder.start(MEDIA_RECORDER_CHUNK_MS);
    } catch (err) {
      logVoice('error', 'recorder-start-failed', { error: err.message || String(err) });
      showIndicator('Record start failed', err.message || String(err), 'error');
      setTimeout(hideIndicator, 3000);
      teardownRecording();
      return false;
    }

    _state.startedAt = Date.now();
    showIndicator('Listening', 'Speak now', 'recording');
    startLevelLoop();
    return true;
  }

  function teardownRecording() {
    stopLevelLoop();
    if (_state.recorder) {
      try {
        if (_state.recorder.state !== 'inactive') _state.recorder.stop();
      } catch {}
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
    if (_state.mode === 'transcribing' || _state.mode === 'idle') return;
    if (!_state.recorder || !_state.recordingId) return;
    const elapsed = Date.now() - _state.startedAt;
    const recordingId = _state.recordingId;
    const recordingPath = _state.recordingPath;
    const recorderMime = _state.recorderMime;

    // 1. Stop MediaRecorder. ondataavailable still fires once with the
    //    final tail chunk. Wait for the recorder to enter 'inactive'
    //    state via the onstop callback so we know all chunks have been
    //    forwarded to main before we ask main to close the file.
    try {
      const recorder = _state.recorder;
      if (recorder && recorder.state === 'recording') {
        const stoppedPromise = new Promise((resolve) => {
          recorder.onstop = resolve;
        });
        recorder.stop();
        await stoppedPromise;
        // Last ondataavailable fires synchronously with onstop in some
        // browsers, asynchronously after in others. Yield once so any
        // queued IPC chunks land before we close the file.
        await new Promise(r => setTimeout(r, 30));
      }
    } catch {}

    // 2. Tear down audio plumbing on the renderer side.
    teardownRecording();
    _state.recordingId = null;
    _state.recordingPath = null;

    if (elapsed < MIN_RECORDING_MS) {
      // Cancel the recording so we don't leave a tiny file behind.
      try { await window.api.voiceRecord.cancel(recordingId); } catch {}
      showIndicator('Too short', 'Hold longer', 'error');
      setTimeout(hideIndicator, 1200);
      _state.mode = 'idle';
      return;
    }

    _state.mode = 'transcribing';
    showIndicator('Transcribing…', '', 'transcribing');

    // Declared outside the try so the catch can reference it.
    let savedWavPath = recordingPath;
    try {
      // 3. Close the file in main and read back its size.
      const closeResult = await window.api.voiceRecord.stop(recordingId);
      savedWavPath = (closeResult && closeResult.path) || savedWavPath;
      const sizeBytes = (closeResult && closeResult.sizeBytes) || 0;
      logVoice('info', 'recorded', {
        ms: elapsed,
        path: recordingPath,
        mime: recorderMime,
        sizeBytes,
        chunksReceived: _state.chunksReceived || 0,
        bytesReceived: _state.bytesReceived || 0,
      });

      // 4. Sanity check: file size must be non-trivial. With Opus at the
      //    default bitrate, ~5 kB/s of speech is typical. Anything below
      //    a few hundred bytes per second of wall-clock recording means
      //    almost no audio reached disk — bail loudly rather than
      //    transcribe garbage.
      if (sizeBytes < 256) {
        throw new Error(`recording file is empty (${sizeBytes} bytes for ${(elapsed/1000).toFixed(1)}s)`);
      }

      // 5. Submit the recorded file to whisper-server. Main does the
      //    multipart assembly so we don't have to load the file back
      //    into renderer memory just to encode it.
      const transcribeResult = await window.api.voiceRecord.transcribeFile(closeResult.path, {
        host: _settings.host,
        port: _settings.port,
        language: _settings.language,
      });
      if (!transcribeResult || !transcribeResult.ok) {
        throw new Error((transcribeResult && transcribeResult.error) || 'transcribe failed');
      }
      const trimmed = flattenWhitespace(transcribeResult.transcript || '');
      logVoice('info', 'transcript', { len: trimmed.length, preview: trimmed.slice(0, 120), path: savedWavPath });
      if (!trimmed) {
        showIndicator('No speech detected', 'Try again, or speak louder', 'error');
        setTimeout(hideIndicator, 2500);
      } else {
        // Always copy to clipboard before injecting — guarantees the user
        // can manually paste even if injection fails or text gets eaten by
        // a TUI mode (slash-command picker, dialog, etc.).
        const clipOk = await writeClipboard(trimmed);
        const sid = window.activeSessionId || sessionStorage.getItem('activeSessionId');
        if (!sid) {
          showIndicator(
            'No active session',
            clipOk ? 'Copied to clipboard — paste manually' : 'Open a Claude session first, then try again',
            'error'
          );
          setTimeout(hideIndicator, 4500);
          logVoice('warn', 'inject-skipped-no-session', { clipboard: clipOk, len: trimmed.length });
        } else {
          const result = await injectText(trimmed, _settings.autoSubmit);
          if (result && result.ok) {
            const preview = trimmed.length > 60 ? trimmed.slice(0, 57) + '…' : trimmed;
            showIndicator('Inserted' + (clipOk ? ' (clipboard backup)' : ''), preview);
            setTimeout(hideIndicator, 2200);
          } else {
            showIndicator(
              'Insert failed',
              clipOk
                ? `Transcript on clipboard — paste with Ctrl+V. Reason: ${(result && result.error) || 'sendInput unavailable'}`
                : (result && result.error) || 'sendInput unavailable',
              'error'
            );
            setTimeout(hideIndicator, 6000);
            logVoice('error', 'inject-failed', { clipboard: clipOk, error: result && result.error, len: trimmed.length });
          }
        }
      }
    } catch (err) {
      logVoice('error', 'transcription-failed', {
        error: err.message || String(err),
        code: err.code || null,
        recordedMs: err.recordedMs || null,
        capturedMs: err.capturedMs || null,
        wav: savedWavPath,
      });
      const detail = (err.message || String(err)) +
        (savedWavPath ? ` — audio saved at ${savedWavPath}` : '');
      showIndicator('Transcription failed', detail, 'error');
      setTimeout(hideIndicator, 8000);
    } finally {
      _state.mode = 'idle';
    }
  }

  async function writeClipboard(text) {
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        await navigator.clipboard.writeText(text);
        return true;
      }
    } catch (err) {
      logVoice('warn', 'clipboard-failed', { error: err.message || String(err) });
    }
    return false;
  }

  function logVoice(level, event, data) {
    try {
      const line = `[voice] ${event} ${JSON.stringify(data || {})}`;
      // Console mirror — handy when DevTools is open.
      const fn = console[level] || console.info;
      fn.call(console, line);
      // Disk mirror — main process forwards to electron-log so a failed
      // dictation leaves an on-disk trace even when DevTools is closed.
      if (window.api && window.api.voiceLog) window.api.voiceLog(level, event, data || {});
    } catch {}
  }

  // ── Raw PCM chunks → 16 kHz mono WAV ──────────────────────────────────
  // Concatenate the Float32 frames the worklet produced, resample from the
  // capture context's native rate (typically 48 kHz) to whisper's 16 kHz
  // via OfflineAudioContext, then encode a 16-bit PCM WAV. No codec round
  // trip, no decodeAudioData — the resampler is the only Web Audio step,
  // and it operates on data we already hold so there's nothing to lose.
  async function pcmChunksToWavBytes(chunks, totalSamples, sourceRate, targetRate) {
    const merged = new Float32Array(totalSamples);
    let off = 0;
    for (const c of chunks) {
      merged.set(c, off);
      off += c.length;
    }
    let final;
    if (sourceRate === targetRate) {
      final = merged;
    } else {
      // Build an AudioBuffer holding our captured samples, render via
      // OfflineAudioContext at the target rate. This uses the same
      // high-quality resampling Chromium uses for normal playback.
      const inCtx = new OfflineAudioContext(1, merged.length, sourceRate);
      const inBuf = inCtx.createBuffer(1, merged.length, sourceRate);
      inBuf.copyToChannel(merged, 0);
      const outLen = Math.ceil(merged.length * targetRate / sourceRate);
      const outCtx = new OfflineAudioContext(1, outLen, targetRate);
      const src = outCtx.createBufferSource();
      src.buffer = inBuf;
      src.connect(outCtx.destination);
      src.start(0);
      const rendered = await outCtx.startRendering();
      final = rendered.getChannelData(0);
    }
    const pcm16 = float32ToPcm16(final);
    return encodeWav(pcm16, targetRate);
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

  // Inference timeout: whisper-server processes large-v3-turbo at roughly
  // realtime/4 on CPU and faster on GPU; 5 minutes of audio is the longest
  // realistic dictation, which decodes well under 2min. Cap at 4min so a
  // wedged request fails loudly instead of hanging the indicator.
  const TRANSCRIBE_TIMEOUT_MS = 4 * 60 * 1000;

  async function transcribeOnce(wavBlob) {
    const endpoint = `http://${_settings.host}:${_settings.port}/inference`;
    const fd = new FormData();
    fd.append('file', wavBlob, 'audio.wav');
    if (_settings.language) fd.append('language', _settings.language);
    fd.append('response_format', 'json');
    fd.append('temperature', '0');
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), TRANSCRIBE_TIMEOUT_MS);
    let res;
    try {
      res = await fetch(endpoint, { method: 'POST', body: fd, signal: ctl.signal });
    } finally {
      clearTimeout(timer);
    }
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      const err = new Error(`HTTP ${res.status} — ${body.slice(0, 160)}`);
      err.status = res.status;
      throw err;
    }
    const data = await res.json();
    const raw = (typeof data.text === 'string') ? data.text : (data.transcription || data.transcript || '');
    return flattenWhitespace(raw);
  }

  async function transcribe(wavBlob) {
    // One automatic retry on network error or 5xx, with a brief delay so
    // an in-flight whisper-server restart (whisper-manager backoff) has a
    // chance to come back up.
    try {
      return await transcribeOnce(wavBlob);
    } catch (err) {
      const retriable = !err.status || err.status >= 500;
      if (!retriable) throw err;
      logVoice('warn', 'transcribe-retry', { reason: err.message || String(err) });
      await new Promise(r => setTimeout(r, 1500));
      return await transcribeOnce(wavBlob);
    }
  }

  // ── Inject into the active terminal ────────────────────────────────────
  // Long transcripts dropped their leading characters when sent as one
  // big sendInput because the receiving TUI processed them char-by-char
  // and the line buffer (~4 KB) overflowed before the app drained it.
  // Bracketed-paste mode (ESC [ 200 ~ ... ESC [ 201 ~) tells the terminal
  // "everything between these markers is one paste block, deliver it
  // atomically" — Claude Code's TUI honours this and reads the whole
  // payload at once instead of replaying it as keystrokes.
  const BRACKETED_PASTE_START = '\x1b[200~';
  const BRACKETED_PASTE_END = '\x1b[201~';

  // Strip control characters from the transcript before injection so a
  // hypothetical ESC byte in the whisper output (vanishingly unlikely
  // for clean speech, but defensive) can't terminate the paste block
  // early or smuggle escape sequences into the terminal.
  function sanitiseForPaste(text) {
    // Keep ordinary printable + common whitespace (\n is already collapsed
    // upstream by flattenWhitespace; tab/CR also dropped here for safety).
    return String(text).replace(/[\x00-\x08\x0b-\x1f\x7f]/g, '');
  }

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
      const safe = sanitiseForPaste(text);
      // Bracketed paste: open marker, payload, close marker. Send as a
      // single sendInput so the markers + text arrive in one PTY write —
      // splitting them risks the terminal seeing an unterminated paste
      // block if a flush happens between writes.
      window.api.sendInput(sid, BRACKETED_PASTE_START + safe + BRACKETED_PASTE_END);
      if (autoSubmit) window.api.sendInput(sid, '\r');
      console.info('[voice] inject ok', { sid, autoSubmit, len: safe.length });
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
      // Only release on the actual PTT key. The previous logic also released
      // on *any* modifier keyup as a fallback for keyboard layouts where the
      // hotkey-down event arrives without a clean keyup, but it had a much
      // worse failure mode: brushing Shift or Ctrl mid-sentence silently
      // ended the recording, producing the "I dictated for 30s and got
      // nothing back" symptom. Sibling-modifier match is still allowed when
      // the PTT key is itself a bare modifier and the user releases the
      // *other* side (e.g. PTT=AltRight, OS only fires AltLeft keyup).
      if (!_state.pttKeyHeld) return;
      const hk = _settings.hotkeyPtt;
      const hkIsModifier = hk && (ALT_CODES.includes(hk.key) || CTRL_CODES.includes(hk.key) ||
                                  SHIFT_CODES.includes(hk.key) || META_CODES.includes(hk.key));
      const sameFamily =
        hkIsModifier && (
          (ALT_CODES.includes(hk.key) && ALT_CODES.includes(ev.code)) ||
          (CTRL_CODES.includes(hk.key) && CTRL_CODES.includes(ev.code)) ||
          (SHIFT_CODES.includes(hk.key) && SHIFT_CODES.includes(ev.code)) ||
          (META_CODES.includes(hk.key) && META_CODES.includes(ev.code))
        );
      if (matches(ev, hk) || sameFamily) {
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
  // {ok, transcript|error} for the settings Test button. Bypasses the
  // hotkey path entirely so you can isolate audio/whisper from keyboard.
  // Uses the same MediaRecorder + stream-to-disk pipeline as the real
  // record-and-transcribe path.
  async function testTranscribe(durationMs) {
    if (_state.mode !== 'idle') return { ok: false, error: 'busy' };
    _state.mode = 'recording-toggle';
    const startedAt = Date.now();
    const ok = await startRecording();
    if (!ok) {
      _state.mode = 'idle';
      return { ok: false, error: 'startRecording failed' };
    }
    await new Promise(r => setTimeout(r, Math.max(500, durationMs || 3000)));

    if (!_state.recorder || !_state.recordingId) {
      _state.mode = 'idle';
      return { ok: false, error: 'no recorder' };
    }
    const recordingId = _state.recordingId;

    // Mirror stopAndTranscribe's stop sequence — without the inject step.
    try {
      const recorder = _state.recorder;
      if (recorder && recorder.state === 'recording') {
        const stoppedPromise = new Promise((resolve) => { recorder.onstop = resolve; });
        recorder.stop();
        await stoppedPromise;
        await new Promise(r => setTimeout(r, 30));
      }
    } catch {}
    teardownRecording();
    _state.recordingId = null;
    _state.recordingPath = null;

    _state.mode = 'transcribing';
    showIndicator('Transcribing test…', '', 'transcribing');
    try {
      const closeResult = await window.api.voiceRecord.stop(recordingId);
      const transcribeResult = await window.api.voiceRecord.transcribeFile(closeResult.path, {
        host: _settings.host,
        port: _settings.port,
        language: _settings.language,
      });
      if (!transcribeResult || !transcribeResult.ok) {
        throw new Error((transcribeResult && transcribeResult.error) || 'transcribe failed');
      }
      const trimmed = flattenWhitespace(transcribeResult.transcript || '');
      showIndicator('Test result', trimmed || '(empty)', trimmed ? null : 'error');
      setTimeout(hideIndicator, 4000);
      _state.mode = 'idle';
      return { ok: true, transcript: trimmed, durationMs: Date.now() - startedAt, path: closeResult.path };
    } catch (err) {
      showIndicator('Test failed', err.message || String(err), 'error');
      setTimeout(hideIndicator, 4000);
      _state.mode = 'idle';
      return { ok: false, error: err.message || String(err) };
    }
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
