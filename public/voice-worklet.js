// voice-worklet.js — AudioWorklet processor that captures raw mono PCM
// from the microphone source and posts Float32 frames back to voice.js
// for accumulation. This replaces the MediaRecorder → WebM → decodeAudioData
// path, which was prone to silent truncation on long dictations.
//
// Runs on the dedicated audio rendering thread, so capture is not subject
// to main-thread jank. Each render quantum is 128 samples by default; we
// post every quantum (cheap, transferable buffer) and let the renderer
// accumulate.

class VoiceCaptureProcessor extends AudioWorkletProcessor {
  process(inputs) {
    const input = inputs[0];
    if (!input || input.length === 0) return true;
    const ch0 = input[0];
    if (!ch0 || ch0.length === 0) return true;
    // Mono mix if stereo arrived (getUserMedia channelCount:1 should
    // already give us mono, but be defensive).
    let out;
    if (input.length > 1 && input[1] && input[1].length === ch0.length) {
      out = new Float32Array(ch0.length);
      const ch1 = input[1];
      for (let i = 0; i < ch0.length; i++) out[i] = (ch0[i] + ch1[i]) * 0.5;
    } else {
      // Copy — the underlying buffer is reused by the audio thread between
      // quanta, so we must not post the original reference.
      out = new Float32Array(ch0.length);
      out.set(ch0);
    }
    this.port.postMessage(out, [out.buffer]);
    return true;
  }
}

registerProcessor('voice-capture', VoiceCaptureProcessor);
