// Alert tones live here rather than in the axiom.trade content script: a page's
// AudioContext is governed by that page's autoplay policy, so it stays
// suspended until the user interacts with the page itself — clicking ▶ in the
// popup is a gesture in a different document and does not count. An offscreen
// document is owned by the extension and plays regardless of which tab is
// focused, or whether an axiom.trade tab is open at all.

const SOUND_PRESETS = {
  soft:   { wave: "sine",     gain: 0.14, tones: [[880, 0.10]] },
  ding:   { wave: "sine",     gain: 0.15, tones: [[1318, 0.07], [1760, 0.15]] },
  double: { wave: "triangle", gain: 0.15, tones: [[988, 0.07], [0, 0.05], [988, 0.09]] },
  rise:   { wave: "sine",     gain: 0.16, tones: [[660, 0.07], [880, 0.07], [1180, 0.14]] },
  alert:  { wave: "triangle", gain: 0.17, tones: [[440, 0.10], [0, 0.04], [440, 0.10], [0, 0.04], [660, 0.16]] },
};

let ctx = null;

async function play(presetName) {
  const preset = SOUND_PRESETS[presetName] || SOUND_PRESETS.soft;
  try {
    if (!ctx) ctx = new AudioContext();
    // Must finish before scheduling: while suspended currentTime is frozen, so
    // notes queued first would land in the past and never sound.
    if (ctx.state === "suspended") {
      try { await ctx.resume(); } catch { /* fall through and try anyway */ }
    }

    // Small lead so the first note is not scheduled at an already-elapsed time.
    let at = ctx.currentTime + 0.02;
    for (const [freq, dur] of preset.tones) {
      if (freq > 0) {
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.type = preset.wave;
        osc.frequency.setValueAtTime(freq, at);
        // Ramps rather than a hard gate — switching a sine on clicks audibly.
        gain.gain.setValueAtTime(0.0001, at);
        gain.gain.exponentialRampToValueAtTime(preset.gain, at + 0.012);
        gain.gain.exponentialRampToValueAtTime(0.0001, at + dur);
        osc.connect(gain);
        gain.connect(ctx.destination);
        osc.start(at);
        osc.stop(at + dur + 0.02);
      }
      at += dur;
    }
  } catch {
    // Audio is a nicety; never let it surface as an extension error.
  }
}

function speakKPredictionRating(percent, tokenName = "") {
  if (!Number.isFinite(percent) || percent < 0 || percent > 100 || !window.speechSynthesis) return;
  try {
    const spokenNumber = percent.toFixed(2).replace(".", ",");
    const safeName = String(tokenName || "").replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, 80);
    const utterance = new SpeechSynthesisUtterance(safeName ? `${safeName}. ${spokenNumber}` : spokenNumber);
    utterance.lang = "ru-RU";
    utterance.rate = 1;
    utterance.pitch = 1;
    utterance.volume = 1;
    const russianVoice = speechSynthesis.getVoices().find((voice) =>
      String(voice.lang || "").toLowerCase().startsWith("ru")
    );
    if (russianVoice) utterance.voice = russianVoice;
    // Keep qualifying tokens in order; cancelling here would cut off the
    // previous token when two predictions arrive close together.
    speechSynthesis.speak(utterance);
  } catch {
    // Voice feedback is optional and must not affect the buy flow.
  }
}

chrome.runtime.onMessage.addListener((msg) => {
  if (!msg || msg.target !== "offscreen") return;
  if (msg.type === "PLAY_SOUND") play(msg.preset);
  if (msg.type === "SPEAK_K_PREDICTION_RATING") speakKPredictionRating(Number(msg.percent), msg.tokenName);
});
