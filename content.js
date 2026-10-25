const SOURCE = "axiom-wl-ext";

let kPredictionAutoBuyEnabled = false;
let kPredictionAutoBuyTriggerMode = "percent";
let kPredictionAutoBuyThresholdPercent = 8;
let kPredictionAutoBuyDecision = "BUY_CANDIDATE";
let kPredictionAutoOpenEnabled = false;
let kPredictionAutoOpenTriggerMode = "percent";
let kPredictionAutoOpenThresholdPercent = 8;
let kPredictionAutoOpenDecision = "BUY_CANDIDATE";
let kPredictionBuySpeechEnabled = false;
const pendingKPredictionAutoBuys = new Map();
const openedKPredictionTokens = new Set();
let autoBuyScanTimer = null;
const AUTO_BUY_PENDING_MS = 15000;
const PULSE_CONTROLS_ID = "axiom-wl-k-prediction-controls";
const PULSE_CONTROLS_STYLE_ID = "axiom-wl-k-prediction-controls-style";

function updatePulseControls() {
  const root = document.getElementById(PULSE_CONTROLS_ID);
  if (!root) return;
  const openButton = root.querySelector('[data-k-prediction-action="open"]');
  const buyButton = root.querySelector('[data-k-prediction-action="buy"]');
  if (openButton) {
    openButton.classList.toggle("is-on", kPredictionAutoOpenEnabled);
    openButton.setAttribute("aria-pressed", String(kPredictionAutoOpenEnabled));
    openButton.title = kPredictionAutoOpenTriggerMode === "status"
      ? `Open tokens with K prediction status ${kPredictionAutoOpenDecision} or higher`
      : `Open tokens at K prediction rating ≥ ${kPredictionAutoOpenThresholdPercent}%`;
    openButton.querySelector(".axiom-wl-mode-state").textContent = kPredictionAutoOpenEnabled ? "ON" : "OFF";
  }
  if (buyButton) {
    buyButton.classList.toggle("is-on", kPredictionAutoBuyEnabled);
    buyButton.setAttribute("aria-pressed", String(kPredictionAutoBuyEnabled));
    buyButton.title = kPredictionAutoBuyTriggerMode === "status"
      ? `Buy tokens with K prediction status ${kPredictionAutoBuyDecision} or higher`
      : `Buy tokens at K prediction rating ≥ ${kPredictionAutoBuyThresholdPercent}%`;
    buyButton.querySelector(".axiom-wl-mode-state").textContent = kPredictionAutoBuyEnabled ? "ON" : "OFF";
  }
}

function ensurePulseControls() {
  if (window !== window.top) return;
  if (location.pathname !== "/pulse") {
    document.getElementById(PULSE_CONTROLS_ID)?.remove();
    return;
  }
  if (!document.getElementById(PULSE_CONTROLS_STYLE_ID)) {
    const style = document.createElement("style");
    style.id = PULSE_CONTROLS_STYLE_ID;
    style.textContent = `
      #${PULSE_CONTROLS_ID} {
        display: inline-flex; align-items: center; gap: 4px; flex: 0 0 auto;
        height: 34px; padding: 3px; margin: 0 4px;
        border: 1px solid rgba(255,255,255,.10); border-radius: 10px;
        background: rgba(10,11,16,.94); box-sizing: border-box;
      }
      #${PULSE_CONTROLS_ID} .axiom-wl-mode {
        display: inline-flex; align-items: center; gap: 5px; height: 26px;
        padding: 0 8px; border: 1px solid transparent; border-radius: 7px;
        background: transparent; color: #777b8d; cursor: pointer;
        font: 700 11px/1 ui-sans-serif, system-ui, sans-serif;
        letter-spacing: .035em; white-space: nowrap; transition: .15s ease;
      }
      #${PULSE_CONTROLS_ID} .axiom-wl-mode:hover { background: rgba(255,255,255,.055); color: #aeb3c3; }
      #${PULSE_CONTROLS_ID} .axiom-wl-mode-dot { width: 6px; height: 6px; border-radius: 999px; background: #4b4f5e; }
      #${PULSE_CONTROLS_ID} .axiom-wl-open.is-on { color: #55c7f7; border-color: rgba(56,189,248,.35); background: rgba(14,165,233,.12); }
      #${PULSE_CONTROLS_ID} .axiom-wl-open.is-on .axiom-wl-mode-dot { background: #38bdf8; box-shadow: 0 0 7px rgba(56,189,248,.75); }
      #${PULSE_CONTROLS_ID} .axiom-wl-buy.is-on { color: #fb923c; border-color: rgba(249,115,22,.42); background: rgba(249,115,22,.13); }
      #${PULSE_CONTROLS_ID} .axiom-wl-buy.is-on .axiom-wl-mode-dot { background: #f97316; box-shadow: 0 0 7px rgba(249,115,22,.8); }
      #${PULSE_CONTROLS_ID} .axiom-wl-mode-state { font-size: 9px; opacity: .82; }
    `;
    (document.head || document.documentElement).appendChild(style);
  }
  if (document.getElementById(PULSE_CONTROLS_ID)) {
    updatePulseControls();
    return;
  }
  const displayButton = Array.from(document.querySelectorAll("button")).find((button) =>
    /(^|\s)Display(\s|$)/.test(button.textContent || "") && button.getClientRects().length > 0
  );
  if (!displayButton?.parentElement) return;
  const root = document.createElement("div");
  root.id = PULSE_CONTROLS_ID;
  root.setAttribute("aria-label", "K prediction actions");
  root.innerHTML = `
    <button type="button" class="axiom-wl-mode axiom-wl-open" data-k-prediction-action="open">
      <span class="axiom-wl-mode-dot"></span><span>OPEN</span><span class="axiom-wl-mode-state">OFF</span>
    </button>
    <button type="button" class="axiom-wl-mode axiom-wl-buy" data-k-prediction-action="buy">
      <span class="axiom-wl-mode-dot"></span><span>BUY</span><span class="axiom-wl-mode-state">OFF</span>
    </button>
  `;
  root.addEventListener("click", (event) => {
    event.preventDefault();
    event.stopPropagation();
    const button = event.target.closest("[data-k-prediction-action]");
    if (!button) return;
    if (button.dataset.kPredictionAction === "open") {
      kPredictionAutoOpenEnabled = !kPredictionAutoOpenEnabled;
      chrome.storage.local.set({ kPredictionAutoOpenEnabled });
    } else if (button.dataset.kPredictionAction === "buy") {
      kPredictionAutoBuyEnabled = !kPredictionAutoBuyEnabled;
      chrome.storage.local.set({ kPredictionAutoBuyEnabled });
    }
    updatePulseControls();
  });
  displayButton.parentElement.insertBefore(root, displayButton);
  updatePulseControls();
}

function normalizeTokenAddress(value) {
  return String(value || "").trim();
}

function predictionConditionMatches(mode, selectedDecision, thresholdPercent, decision, percent) {
  if (mode !== "status") return percent >= thresholdPercent;
  const rank = { SKIP: 0, WATCH: 1, BUY_CANDIDATE: 2 };
  return Number.isInteger(rank[decision]) &&
    Number.isInteger(rank[selectedDecision]) &&
    rank[decision] >= rank[selectedDecision];
}

function findQuickBuyButton(tokenAddress) {
  const rows = Array.from(document.querySelectorAll("[data-token-address]"));
  let row = rows.find((candidate) =>
    normalizeTokenAddress(candidate.getAttribute("data-token-address")) === tokenAddress
  );
  if (!row) {
    const pumpLink = Array.from(document.querySelectorAll("a[href*='pump.fun/coin/']"))
      .find((link) => link.getAttribute("href")?.includes(`/coin/${tokenAddress}`));
    row = pumpLink?.closest("[data-token-address], [class*='group/pulseRow']") || null;
  }
  if (!row) return null;
  const buttons = Array.from(row.querySelectorAll("button[class*='group/quickBuyButton']"));
  return buttons.find((button) =>
    !button.disabled &&
    button.getAttribute("aria-disabled") !== "true" &&
    button.getClientRects().length > 0
  ) || null;
}

function stopAutoBuyScannerIfIdle() {
  if (pendingKPredictionAutoBuys.size || !autoBuyScanTimer) return;
  clearInterval(autoBuyScanTimer);
  autoBuyScanTimer = null;
}

function clearPendingPredictionActions() {
  pendingKPredictionAutoBuys.clear();
  stopAutoBuyScannerIfIdle();
}

function requestAutoBuyClaim(tokenAddress, entry, button) {
  if (entry.claiming) return;
  entry.claiming = true;
  if (entry.action === "open") {
    openedKPredictionTokens.add(tokenAddress);
    pendingKPredictionAutoBuys.delete(tokenAddress);
    stopAutoBuyScannerIfIdle();
    console.info("[axiom-wl] K prediction auto-open", {
      tokenAddress,
      probability: entry.probability,
      thresholdPercent: kPredictionAutoOpenThresholdPercent,
    });
    button.click();
    return;
  }
  const rect = button.getBoundingClientRect();
  chrome.runtime.sendMessage(
    {
      type: "K_PREDICTION_AUTO_BUY_EXECUTE",
      tokenAddress,
      point: {
        x: rect.left + rect.width / 2,
        y: rect.top + rect.height / 2,
      },
    },
    (response) => {
      entry.claiming = false;
      if (chrome.runtime.lastError) return;
      if (!response?.executed) return;
      pendingKPredictionAutoBuys.delete(tokenAddress);
      stopAutoBuyScannerIfIdle();
      console.info("[axiom-wl] K prediction auto-buy", {
        tokenAddress,
        probability: entry.probability,
        thresholdPercent: kPredictionAutoBuyThresholdPercent,
        amount: button.textContent?.trim() || "current Quick Buy amount",
        method: "trusted Axiom Quick Buy click",
      });
      if (kPredictionBuySpeechEnabled) {
        chrome.runtime.sendMessage({
          type: "SPEAK_K_PREDICTION_RATING",
          percent: Number((entry.probability * 100).toFixed(2)),
        });
      }
    }
  );
}

function processPendingAutoBuys() {
  if ((!kPredictionAutoBuyEnabled && !kPredictionAutoOpenEnabled) || window !== window.top) {
    pendingKPredictionAutoBuys.clear();
    stopAutoBuyScannerIfIdle();
    return;
  }
  const now = Date.now();
  for (const [tokenAddress, entry] of pendingKPredictionAutoBuys) {
    if (now - entry.receivedAt > AUTO_BUY_PENDING_MS) {
      pendingKPredictionAutoBuys.delete(tokenAddress);
      continue;
    }
    const button = findQuickBuyButton(tokenAddress);
    if (button) requestAutoBuyClaim(tokenAddress, entry, button);
  }
  stopAutoBuyScannerIfIdle();
}

function queueKPredictionAutoBuy(payload) {
  if ((!kPredictionAutoBuyEnabled && !kPredictionAutoOpenEnabled) || window !== window.top) return;
  const tokenAddress = normalizeTokenAddress(payload?.token_address ?? payload?.tokenAddress);
  const prediction = payload?.prediction || payload;
  const probability = prediction?.probability ?? prediction?.p_k_buy;
  const decision = String(prediction?.decision ?? prediction?.selection_decision ?? "").toUpperCase();
  if (!/^[A-Za-z0-9]{32,44}$/.test(tokenAddress)) return;
  if (typeof probability !== "number" || !Number.isFinite(probability) || probability < 0 || probability > 1) return;
  if (!["BUY_CANDIDATE", "WATCH", "SKIP"].includes(decision)) return;
  const percent = probability * 100;
  const action = kPredictionAutoBuyEnabled && predictionConditionMatches(
    kPredictionAutoBuyTriggerMode,
    kPredictionAutoBuyDecision,
    kPredictionAutoBuyThresholdPercent,
    decision,
    percent
  )
    ? "buy"
    : kPredictionAutoOpenEnabled && predictionConditionMatches(
      kPredictionAutoOpenTriggerMode,
      kPredictionAutoOpenDecision,
      kPredictionAutoOpenThresholdPercent,
      decision,
      percent
    )
      ? "open"
      : null;
  if (!action) {
    pendingKPredictionAutoBuys.delete(tokenAddress);
    stopAutoBuyScannerIfIdle();
    return;
  }
  if (action === "open" && openedKPredictionTokens.has(tokenAddress)) return;
  const current = pendingKPredictionAutoBuys.get(tokenAddress);
  if (current?.claiming || current?.action === "buy") return;
  pendingKPredictionAutoBuys.set(tokenAddress, {
    probability,
    decision,
    action,
    receivedAt: Date.now(),
    claiming: false,
  });
  processPendingAutoBuys();
  if (pendingKPredictionAutoBuys.size && !autoBuyScanTimer) {
    autoBuyScanTimer = setInterval(processPendingAutoBuys, 250);
  }
}

function postWhitelist(
  twitterWl,
  devWl,
  positionThreshold,
  reuseThreshold,
  quickBuyFeesEnabled,
  showDevVolume,
  showDevPreviousLaunch,
  showTwitterVolume,
  showTwitterPreviousLaunch,
  showUpdateBDelay,
  feeHighlightThreshold,
  feeHighlightColor,
  feeTokenCount,
  devVolBadgeThreshold,
  devVolBadgeColor,
  twitterVolBadgeThreshold,
  twitterVolBadgeColor,
  showTrustBadge,
  showDevVolBadge,
  showTwitterVolBadge
) {
  window.postMessage(
    {
      source: SOURCE,
      type: "WL_UPDATE",
      payload: {
        twitterWl,
        devWl,
        positionThreshold,
        reuseThreshold,
        quickBuyFeesEnabled,
        showDevVolume,
        showDevPreviousLaunch,
        showTwitterVolume,
        showTwitterPreviousLaunch,
        showUpdateBDelay,
        feeHighlightThreshold,
        feeHighlightColor,
        feeTokenCount,
        devVolBadgeThreshold,
        devVolBadgeColor,
        twitterVolBadgeThreshold,
        twitterVolBadgeColor,
        showTrustBadge,
        showDevVolBadge,
        showTwitterVolBadge,
      },
    },
    "*"
  );
}

function injectScript() {
  const script = document.createElement("script");
  const version = chrome.runtime.getManifest().version;
  script.src = `${chrome.runtime.getURL("injected.js")}?v=${encodeURIComponent(version)}`;
  script.onload = () => script.remove();
  (document.head || document.documentElement).appendChild(script);
}

async function init() {
  injectScript();
  const data = await chrome.storage.local.get({
    positionThreshold: 1,
    reuseThreshold: 1,
    quickBuyFeesEnabled: true,
    showDevVolume: true,
    showDevPreviousLaunch: true,
    showTwitterVolume: true,
    showTwitterPreviousLaunch: true,
    showUpdateBDelay: true,
    feeHighlightThreshold: 2,
    feeHighlightColor: "#f59e0b",
    feeTokenCount: 5,
    combinedVolThreshold: 10000,
    showTrustBadge: true,
    showDevVolBadge: true,
    showTwitterVolBadge: true,
    devVolBadgeThreshold: 10000,
    devVolBadgeColor: "#22c55e",
    twitterVolBadgeThreshold: 10000,
    twitterVolBadgeColor: "#3b82f6",
    kPredictionCache: {},
    kPredictionAutoOpenEnabled: false,
    kPredictionAutoOpenTriggerMode: "percent",
    kPredictionAutoOpenThresholdPercent: 8,
    kPredictionAutoOpenDecision: "BUY_CANDIDATE",
    kPredictionAutoBuyEnabled: false,
    kPredictionAutoBuyTriggerMode: "percent",
    kPredictionAutoBuyThresholdPercent: 8,
    kPredictionAutoBuyDecision: "BUY_CANDIDATE",
    kPredictionBuySpeechEnabled: false,
  });
  kPredictionAutoOpenEnabled = !!data.kPredictionAutoOpenEnabled;
  kPredictionAutoOpenTriggerMode = data.kPredictionAutoOpenTriggerMode === "status" ? "status" : "percent";
  kPredictionAutoOpenDecision = String(data.kPredictionAutoOpenDecision || "BUY_CANDIDATE").toUpperCase();
  const autoOpenThreshold = Number(data.kPredictionAutoOpenThresholdPercent);
  kPredictionAutoOpenThresholdPercent = Number.isFinite(autoOpenThreshold)
    ? Math.min(100, Math.max(0, autoOpenThreshold))
    : 8;
  kPredictionAutoBuyEnabled = !!data.kPredictionAutoBuyEnabled;
  kPredictionAutoBuyTriggerMode = data.kPredictionAutoBuyTriggerMode === "status" ? "status" : "percent";
  kPredictionAutoBuyDecision = String(data.kPredictionAutoBuyDecision || "BUY_CANDIDATE").toUpperCase();
  const autoBuyThreshold = Number(data.kPredictionAutoBuyThresholdPercent);
  kPredictionAutoBuyThresholdPercent = Number.isFinite(autoBuyThreshold)
    ? Math.min(100, Math.max(0, autoBuyThreshold))
    : 8;
  kPredictionBuySpeechEnabled = !!data.kPredictionBuySpeechEnabled;
  ensurePulseControls();
  const fht = data.feeHighlightThreshold ?? 2;
  const fhc = data.feeHighlightColor || "#f59e0b";
  const ftc = data.feeTokenCount ?? 5;
  const dvt = data.devVolBadgeThreshold ?? data.combinedVolThreshold ?? 10000;
  const dvc = data.devVolBadgeColor || "#22c55e";
  const tvt = data.twitterVolBadgeThreshold ?? data.combinedVolThreshold ?? 10000;
  const tvc = data.twitterVolBadgeColor || "#3b82f6";
  const displayFlags = [
    data.showDevVolume !== false,
    data.showDevPreviousLaunch !== false,
    data.showTwitterVolume !== false,
    data.showTwitterPreviousLaunch !== false,
    data.showUpdateBDelay !== false,
  ];
  postWhitelist([], [], data.positionThreshold, data.reuseThreshold, data.quickBuyFeesEnabled !== false, ...displayFlags, fht, fhc, ftc, dvt, dvc, tvt, tvc, data.showTrustBadge !== false, data.showDevVolBadge !== false, data.showTwitterVolBadge !== false);
  setTimeout(() => postWhitelist([], [], data.positionThreshold, data.reuseThreshold, data.quickBuyFeesEnabled !== false, ...displayFlags, fht, fhc, ftc, dvt, dvc, tvt, tvc, data.showTrustBadge !== false, data.showDevVolBadge !== false, data.showTwitterVolBadge !== false), 150);
  setTimeout(() => postWhitelist([], [], data.positionThreshold, data.reuseThreshold, data.quickBuyFeesEnabled !== false, ...displayFlags, fht, fhc, ftc, dvt, dvc, tvt, tvc, data.showTrustBadge !== false, data.showDevVolBadge !== false, data.showTwitterVolBadge !== false), 1200);
  const kPredictionCache = data.kPredictionCache || {};
  if (Object.keys(kPredictionCache).length > 0) {
    setTimeout(() => {
      window.postMessage({ source: SOURCE, type: "K_PREDICTION_CACHE", payload: kPredictionCache }, "*");
    }, 650);
  }
  console.log("[axiom-wl] content loaded", {
    href: location.href,
    inIframe: window !== window.top,
  });
  maybeQueryWsCacheForTokenPage();
}

function maybeQueryWsCacheForTokenPage() {
  const m = location.pathname.match(/^\/(?:meme|coin|pair)\/([A-Za-z0-9]{32,44})/);
  if (!m) return;
  const key = m[1];
  chrome.runtime.sendMessage(
    { type: "WS_CACHE_QUERY", keys: [key] },
    (response) => {
      if (chrome.runtime.lastError) return;
      const entries = response?.entries || {};
      if (!Object.keys(entries).length) return;
      window.postMessage(
        { source: SOURCE, type: "WS_CACHE_RESPONSE", payload: entries },
        "*"
      );
    }
  );
}

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local") return;
  if (changes.kPredictionAutoOpenEnabled) {
    kPredictionAutoOpenEnabled = !!changes.kPredictionAutoOpenEnabled.newValue;
    if (!kPredictionAutoOpenEnabled && !kPredictionAutoBuyEnabled) {
      pendingKPredictionAutoBuys.clear();
      stopAutoBuyScannerIfIdle();
    }
    updatePulseControls();
  }
  if (changes.kPredictionAutoOpenThresholdPercent) {
    const value = Number(changes.kPredictionAutoOpenThresholdPercent.newValue);
    if (Number.isFinite(value)) kPredictionAutoOpenThresholdPercent = Math.min(100, Math.max(0, value));
    clearPendingPredictionActions();
    updatePulseControls();
  }
  if (changes.kPredictionAutoOpenTriggerMode) {
    kPredictionAutoOpenTriggerMode = changes.kPredictionAutoOpenTriggerMode.newValue === "status" ? "status" : "percent";
    clearPendingPredictionActions();
    updatePulseControls();
  }
  if (changes.kPredictionAutoOpenDecision) {
    kPredictionAutoOpenDecision = String(changes.kPredictionAutoOpenDecision.newValue || "BUY_CANDIDATE").toUpperCase();
    clearPendingPredictionActions();
    updatePulseControls();
  }
  if (changes.kPredictionAutoBuyEnabled) {
    kPredictionAutoBuyEnabled = !!changes.kPredictionAutoBuyEnabled.newValue;
    if (!kPredictionAutoBuyEnabled && !kPredictionAutoOpenEnabled) {
      pendingKPredictionAutoBuys.clear();
      stopAutoBuyScannerIfIdle();
    }
    updatePulseControls();
  }
  if (changes.kPredictionAutoBuyThresholdPercent) {
    const value = Number(changes.kPredictionAutoBuyThresholdPercent.newValue);
    if (Number.isFinite(value)) kPredictionAutoBuyThresholdPercent = Math.min(100, Math.max(0, value));
    clearPendingPredictionActions();
    updatePulseControls();
  }
  if (changes.kPredictionAutoBuyTriggerMode) {
    kPredictionAutoBuyTriggerMode = changes.kPredictionAutoBuyTriggerMode.newValue === "status" ? "status" : "percent";
    clearPendingPredictionActions();
    updatePulseControls();
  }
  if (changes.kPredictionAutoBuyDecision) {
    kPredictionAutoBuyDecision = String(changes.kPredictionAutoBuyDecision.newValue || "BUY_CANDIDATE").toUpperCase();
    clearPendingPredictionActions();
    updatePulseControls();
  }
  if (changes.kPredictionBuySpeechEnabled) {
    kPredictionBuySpeechEnabled = !!changes.kPredictionBuySpeechEnabled.newValue;
  }
  const positionThreshold = changes.positionThreshold?.newValue;
  const reuseThreshold = changes.reuseThreshold?.newValue;
  const quickBuyFeesEnabled = changes.quickBuyFeesEnabled?.newValue;
  const showDevVolume = changes.showDevVolume?.newValue;
  const showDevPreviousLaunch = changes.showDevPreviousLaunch?.newValue;
  const showTwitterVolume = changes.showTwitterVolume?.newValue;
  const showTwitterPreviousLaunch = changes.showTwitterPreviousLaunch?.newValue;
  const showUpdateBDelay = changes.showUpdateBDelay?.newValue;
  const feeHighlightThreshold = changes.feeHighlightThreshold?.newValue;
  const feeHighlightColor = changes.feeHighlightColor?.newValue;
  const feeTokenCount = changes.feeTokenCount?.newValue;
  const showTrustBadge = changes.showTrustBadge?.newValue;
  const showDevVolBadge = changes.showDevVolBadge?.newValue;
  const showTwitterVolBadge = changes.showTwitterVolBadge?.newValue;
  const devVolBadgeThreshold = changes.devVolBadgeThreshold?.newValue;
  const devVolBadgeColor = changes.devVolBadgeColor?.newValue;
  const twitterVolBadgeThreshold = changes.twitterVolBadgeThreshold?.newValue;
  const twitterVolBadgeColor = changes.twitterVolBadgeColor?.newValue;
  if (
    positionThreshold !== undefined ||
    reuseThreshold !== undefined ||
    quickBuyFeesEnabled !== undefined ||
    showDevVolume !== undefined ||
    showDevPreviousLaunch !== undefined ||
    showTwitterVolume !== undefined ||
    showTwitterPreviousLaunch !== undefined ||
    showUpdateBDelay !== undefined ||
    feeHighlightThreshold !== undefined ||
    feeHighlightColor ||
    feeTokenCount !== undefined ||
    showTrustBadge !== undefined ||
    showDevVolBadge !== undefined ||
    showTwitterVolBadge !== undefined ||
    devVolBadgeThreshold !== undefined ||
    devVolBadgeColor ||
    twitterVolBadgeThreshold !== undefined ||
    twitterVolBadgeColor
  ) {
    postWhitelist([], [], positionThreshold, reuseThreshold, quickBuyFeesEnabled, showDevVolume, showDevPreviousLaunch, showTwitterVolume, showTwitterPreviousLaunch, showUpdateBDelay, feeHighlightThreshold, feeHighlightColor, feeTokenCount, devVolBadgeThreshold, devVolBadgeColor, twitterVolBadgeThreshold, twitterVolBadgeColor, showTrustBadge, showDevVolBadge, showTwitterVolBadge);
  }
});

// ── Whitelist-match alert tones ────────────────────────────────
// Synthesised rather than shipped as audio files: no binary assets, no
// web_accessible_resources entry, and each preset stays distinguishable.
const SOUND_PRESETS = {
  soft:   { wave: "sine",     gain: 0.14, tones: [[880, 0.10]] },
  ding:   { wave: "sine",     gain: 0.15, tones: [[1318, 0.07], [1760, 0.15]] },
  double: { wave: "triangle", gain: 0.15, tones: [[988, 0.07], [0, 0.05], [988, 0.09]] },
  rise:   { wave: "sine",     gain: 0.16, tones: [[660, 0.07], [880, 0.07], [1180, 0.14]] },
  alert:  { wave: "triangle", gain: 0.17, tones: [[440, 0.10], [0, 0.04], [440, 0.10], [0, 0.04], [660, 0.16]] },
};

let audioCtx = null;

// Fallback only — background normally plays alerts through its offscreen
// document, which is not bound by this page's autoplay policy.
async function playPreset(name) {
  // This script is injected into every frame; without this the tone would be
  // played once per iframe and overlap with itself.
  if (window !== window.top) return;
  const preset = SOUND_PRESETS[name] || SOUND_PRESETS.soft;
  try {
    if (!audioCtx) {
      const Ctx = window.AudioContext || window.webkitAudioContext;
      if (!Ctx) return;
      audioCtx = new Ctx();
    }
    // Await it: while suspended currentTime is frozen, so notes scheduled
    // before the resume completes land in the past and never sound.
    if (audioCtx.state === "suspended") {
      try { await audioCtx.resume(); } catch { /* try anyway */ }
    }

    let at = audioCtx.currentTime + 0.02;
    for (const [freq, dur] of preset.tones) {
      if (freq > 0) {
        const osc = audioCtx.createOscillator();
        const gain = audioCtx.createGain();
        osc.type = preset.wave;
        osc.frequency.setValueAtTime(freq, at);
        // Short fade in/out — a raw gate on a sine clicks audibly.
        gain.gain.setValueAtTime(0.0001, at);
        gain.gain.exponentialRampToValueAtTime(preset.gain, at + 0.012);
        gain.gain.exponentialRampToValueAtTime(0.0001, at + dur);
        osc.connect(gain);
        gain.connect(audioCtx.destination);
        osc.start(at);
        osc.stop(at + dur + 0.02);
      }
      at += dur;
    }
  } catch {
    // Audio is a nicety; never let it break the feed.
  }
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || typeof msg !== "object") return;
  if (msg.type === "PLAY_SOUND") {
    playPreset(msg.preset);
    return;
  }
  // The checker needs the token address, but the URL only carries the pair.
  // The pump.fun link on the page is the one place the page states it.
  if (msg.type === "GET_TOKEN_ADDRESS") {
    let tokenAddress = "";
    const link = document.querySelector("a[href*='pump.fun/coin/']");
    const m = link?.getAttribute("href")?.match(/pump\.fun\/coin\/([A-Za-z0-9]{32,44})/);
    if (m) tokenAddress = m[1];
    sendResponse({ tokenAddress });
    return true;
  }
  if (msg.type === "SOL_UPDATE_B") {
    window.postMessage(
      {
        source: SOURCE,
        type: "SOL_UPDATE_B",
        payload: msg.payload,
      },
      "*"
    );
  }
  if (msg.type === "WS_LOCAL_UPDATE") {
    if (msg.payload?.type === "k_prediction" && !msg.payload?.preliminary) {
      queueKPredictionAutoBuy(msg.payload);
    }
    window.postMessage(
      {
        source: SOURCE,
        type: "WS_LOCAL_UPDATE",
        payload: msg.payload,
      },
      "*"
    );
  }
  if (msg.type === "WS_STATUS") {
    window.postMessage(
      {
        source: SOURCE,
        type: "WS_STATUS",
        payload: { status: msg.status },
      },
      "*"
    );
  }
});

window.addEventListener("message", (event) => {
  if (!event?.data || event.data.source !== SOURCE) return;
  if (event.source === window && event.data.type === "PULSE_READY_REQUEST") {
    const requestId = event.data.requestId;
    chrome.runtime.sendMessage({ type: "PULSE_READY_BATCH",
      tokenAddresses: event.data.tokenAddresses, pairAddresses: event.data.pairAddresses }, (response) => {
      const failed = !!chrome.runtime.lastError;
      window.postMessage({ source: SOURCE, type: "PULSE_READY_RESPONSE", requestId,
        ...(failed ? { success: false } : response || { success: false }) }, "*");
    });
    return;
  }
  if (event.data.type === "WS_CONNECT_REQ") {
    chrome.runtime.sendMessage({ type: "WS_CONNECT" });
  }
  if (event.data.type === "WS_DISCONNECT_REQ") {
    chrome.runtime.sendMessage({ type: "WS_DISCONNECT" });
  }
  if (event.data.type === "WS_STATUS_REQ") {
    chrome.runtime.sendMessage({ type: "WS_STATUS_REQ" });
  }
});

init();

// Detect SPA navigation to re-query cache on route change
let _lastPath = location.pathname;
setInterval(() => {
  if (location.pathname !== _lastPath) {
    _lastPath = location.pathname;
    maybeQueryWsCacheForTokenPage();
  }
  ensurePulseControls();
}, 600);
