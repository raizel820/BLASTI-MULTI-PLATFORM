/**
 * Generates the BLASTI turn-call alarm sound as a WAV file.
 *
 * Output: two-tone rising alert (880 Hz → 1174 Hz) repeated twice,
 * 16-bit PCM mono @ 44.1 kHz, ~1.8 s, normalized to -3 dBFS with
 * fade-in/fade-out so it loops cleanly in the notification channel.
 *
 * Usage: bun scripts/generate-alarm-wav.ts
 * Writes to:
 *   apps/mobile/android/app/src/main/res/raw/blasti_alarm.wav
 *   apps/web/public/blasti_alarm.wav
 */

const SAMPLE_RATE = 44_100;
const TONE_SECONDS = 0.45; // per tone
const GAP_SECONDS = 0.08; // silence between tones
const CYCLE = [880, 1174.7]; // A5 → D6 (two-tone rising chime)
const REPEATS = 2;
const AMP = Math.pow(10, -3 / 20); // -3 dBFS

function synthesize(): Float64Array {
  const toneSamples = Math.round(TONE_SECONDS * SAMPLE_RATE);
  const gapSamples = Math.round(GAP_SECONDS * SAMPLE_RATE);
  const cycleSamples = (toneSamples + gapSamples) * CYCLE.length;
  const total = cycleSamples * REPEATS;
  const data = new Float64Array(total);

  let i = 0;
  for (let rep = 0; rep < REPEATS; rep++) {
    for (const freq of CYCLE) {
      for (let n = 0; n < toneSamples; n++, i++) {
        const t = n / SAMPLE_RATE;
        // Fundamental + a touch of 2nd harmonic for a warmer alarm timbre
        const env = Math.min(1, n / (0.01 * SAMPLE_RATE), (toneSamples - n) / (0.05 * SAMPLE_RATE));
        data[i] = env * (0.8 * Math.sin(2 * Math.PI * freq * t) + 0.2 * Math.sin(2 * Math.PI * freq * 2 * t));
      }
      // Inter-tone gap
      for (let n = 0; n < gapSamples; n++, i++) data[i] = 0;
    }
  }
  return data;
}

function toWav(samples: Float64Array): Buffer {
  const dataLen = samples.length * 2; // 16-bit mono
  const buf = Buffer.alloc(44 + dataLen);

  buf.write('RIFF', 0);
  buf.writeUInt32LE(36 + dataLen, 4);
  buf.write('WAVE', 8);
  buf.write('fmt ', 12);
  buf.writeUInt32LE(16, 16); // PCM chunk size
  buf.writeUInt16LE(1, 20); // PCM format
  buf.writeUInt16LE(1, 22); // mono
  buf.writeUInt32LE(SAMPLE_RATE, 24);
  buf.writeUInt32LE(SAMPLE_RATE * 2, 28); // byte rate
  buf.writeUInt16LE(2, 32); // block align
  buf.writeUInt16LE(16, 34); // bits per sample
  buf.write('data', 36);
  buf.writeUInt32LE(dataLen, 40);

  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i] * AMP));
    buf.writeInt16LE(Math.round(s * 32767), 44 + i * 2);
  }
  return buf;
}

const wav = toWav(synthesize());
const targets = [
  'apps/mobile/android/app/src/main/res/raw/blasti_alarm.wav',
  'apps/web/public/blasti_alarm.wav',
];
for (const t of targets) {
  await Bun.write(t, wav);
  console.log(`wrote ${t} (${wav.length} bytes)`);
}
