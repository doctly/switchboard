// voice-worklet.js — AudioWorklet processor that captures raw mono PCM
// from the microphone source and posts batched Float32 frames back to
// voice.js for accumulation. Replaces the MediaRecorder → WebM →
// decodeAudioData path, which was prone to silent truncation on long
// dictations.
//
// Critical: this runs on the dedicated audio rendering thread, so capture
// itself is not subject to main-thread jank. BUT the postMessage from the
// worklet to the main thread IS subject to the main thread keeping up
// with messages. If the main thread is busy (scrolling, layout, GC), the
// internal IPC queue can drop messages — and we lose audio frames with
// no exception thrown.
//
// To avoid that we BATCH ~50 render quanta (≈6,400 samples / ≈133 ms at
// 48 kHz) into a single buffer before posting. This cuts the message rate
// from ~370/sec to ~7/sec — well within what the main thread can absorb
// even under load. Trade-off: at most ~133 ms of capture lag at the end
// of a recording, paid by flushing the partial batch from the renderer
// side when capture stops (we hold a complete-batch invariant here, the
// flush is renderer-side).

const BATCH_SAMPLES = 6400;  // ~133 ms at 48 kHz, ~400 ms at 16 kHz

class VoiceCaptureProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this._buffer = new Float32Array(BATCH_SAMPLES);
    this._offset = 0;
    // Stats: total samples observed and total samples posted. The
    // renderer reads these on flush to verify nothing was lost in the
    // worklet itself.
    this._observed = 0;
    this._posted = 0;
    this.port.onmessage = (ev) => {
      // Renderer requesting a flush of the partial batch (e.g. on stop).
      if (ev && ev.data && ev.data.type === 'flush') {
        this._flush();
        // Send a final summary so the renderer can sanity-check.
        this.port.postMessage({ type: 'final', observed: this._observed, posted: this._posted });
      }
    };
  }

  _flush() {
    if (this._offset === 0) return;
    const out = this._buffer.subarray(0, this._offset);
    // Copy out — _buffer is reused.
    const slice = new Float32Array(out.length);
    slice.set(out);
    this.port.postMessage(slice, [slice.buffer]);
    this._posted += slice.length;
    this._offset = 0;
  }

  process(inputs) {
    const input = inputs[0];
    if (!input || input.length === 0) return true;
    const ch0 = input[0];
    if (!ch0 || ch0.length === 0) return true;

    // Mono mix if stereo arrived (getUserMedia channelCount:1 should
    // already give us mono, but be defensive).
    let frame;
    if (input.length > 1 && input[1] && input[1].length === ch0.length) {
      frame = new Float32Array(ch0.length);
      const ch1 = input[1];
      for (let i = 0; i < ch0.length; i++) frame[i] = (ch0[i] + ch1[i]) * 0.5;
    } else {
      frame = ch0;  // we'll copy into the batch buffer below
    }

    this._observed += frame.length;

    // Append to batch buffer. If the frame would overflow the current
    // batch, flush first then append the remainder.
    let written = 0;
    while (written < frame.length) {
      const space = BATCH_SAMPLES - this._offset;
      const toCopy = Math.min(space, frame.length - written);
      this._buffer.set(frame.subarray(written, written + toCopy), this._offset);
      this._offset += toCopy;
      written += toCopy;
      if (this._offset >= BATCH_SAMPLES) {
        this._flush();
      }
    }
    return true;
  }
}

registerProcessor('voice-capture', VoiceCaptureProcessor);
