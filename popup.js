// Settings live in chrome.storage.local; content.js and background.js both
// watch it, so a save lands on the feed without a reload.
//
// Everything below the connect bar is written by the single Save button. The
// access key is the exception: Connect needs it immediately, so it is also
// persisted on blur and before connecting.

const SOUND_PRESETS = ["soft", "ding", "double", "rise", "alert"];

const SOUND_FIELDS = [
  { enabled: "soundDevOnlyEnabled", name: "soundDevOnlyName", fallback: "soft" },
  { enabled: "soundTwitterOnlyEnabled", name: "soundTwitterOnlyName", fallback: "ding" },
  { enabled: "soundBothEnabled", name: "soundBothName", fallback: "rise" },
];

const DEFAULTS = {
  msfServerUrl: "",
  msfWsToken: "",
  devWhitelist: [],
  twitterWhitelist: [],
  kPredictionAutoOpenEnabled: false,
  kPredictionAutoOpenTriggerMode: "percent",
  kPredictionAutoOpenThresholdPercent: 8,
  kPredictionAutoOpenDecision: "BUY_CANDIDATE",
  kPredictionAutoBuyEnabled: false,
  kPredictionAutoBuyTriggerMode: "percent",
  kPredictionAutoBuyThresholdPercent: 8,
  kPredictionAutoBuyDecision: "BUY_CANDIDATE",
  kPredictionBuySpeechEnabled: false,
  kPredictionRatingCheckerEnabled: false,
  kPredictionRatingCheckerTriggerMode: "percent",
  kPredictionRatingCheckerThresholdPercent: 8,
  kPredictionRatingCheckerDecision: "BUY_CANDIDATE",
  soundDevOnlyEnabled: false,
  soundDevOnlyName: "soft",
  soundTwitterOnlyEnabled: false,
  soundTwitterOnlyName: "ding",
  soundBothEnabled: true,
  soundBothName: "rise",
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
};

const $ = (id) => document.getElementById(id);

const statusEl = $("status");
const saveEl = $("save");
const wsTokenEl = $("wsToken");
const serverAddressEl = $("serverAddress");
const devWlEl = $("devWlTextarea");
const twitterWlEl = $("twitterWlTextarea");
const wlCountsEl = $("wlCounts");
let lastWsStatus = "disconnected";

// ---------------------------------------------------------------- helpers

function isEvmAddress(v) {
  return /^0x[0-9a-fA-F]{40}$/.test(v);
}

// Must match how background.js normalises before comparing, or an entry added
// here would never match. SOL base58 is case-sensitive; EVM is not.
const normalizeDev = (v) => (isEvmAddress(v) ? v.toLowerCase() : v);
// Handles are stored exactly as typed — no @-stripping, no lowercasing.
const normalizeHandle = (v) => v;

function parseLines(text, normalize) {
  const seen = new Set();
  const out = [];
  for (const line of String(text || "").split(/\r?\n/)) {
    const value = normalize(line.trim());
    if (!value || seen.has(value)) continue;
    seen.add(value);
    out.push(value);
  }
  return out;
}

function renderWlCounts() {
  const devs = parseLines(devWlEl.value, normalizeDev).length;
  const handles = parseLines(twitterWlEl.value, normalizeHandle).length;
  wlCountsEl.textContent = `${devs} dev · ${handles} tw`;
}

function num(id, fallback, min) {
  const raw = Number($(id).value);
  const v = Number.isFinite(raw) ? raw : fallback;
  return min !== undefined ? Math.max(min, v) : v;
}

const CONDITION_GROUPS = {
  open: "kPredictionAutoOpenTriggerMode",
  buy: "kPredictionAutoBuyTriggerMode",
  voice: "kPredictionRatingCheckerTriggerMode",
};

function updateConditionVisibility(group) {
  const mode = $(CONDITION_GROUPS[group])?.value === "status" ? "status" : "percent";
  document.querySelectorAll(`[data-condition-percent="${group}"]`).forEach((row) => {
    row.hidden = mode !== "percent";
  });
  document.querySelectorAll(`[data-condition-status="${group}"]`).forEach((row) => {
    row.hidden = mode !== "status";
  });
}

// ---------------------------------------------------------------- load

function fillSoundSelects() {
  for (const f of SOUND_FIELDS) {
    const el = $(f.name);
    if (!el || el.options.length) continue;
    for (const preset of SOUND_PRESETS) {
      const opt = document.createElement("option");
      opt.value = preset;
      opt.textContent = preset;
      el.appendChild(opt);
    }
  }
}

async function load() {
  const d = await chrome.storage.local.get(DEFAULTS);

  serverAddressEl.value = d.msfServerUrl || "";
  wsTokenEl.value = d.msfWsToken || "";
  devWlEl.value = (d.devWhitelist || []).join("\n");
  twitterWlEl.value = (d.twitterWhitelist || []).join("\n");
  renderWlCounts();

  $("kPredictionAutoOpenEnabled").checked = !!d.kPredictionAutoOpenEnabled;
  $("kPredictionAutoOpenTriggerMode").value = d.kPredictionAutoOpenTriggerMode === "status" ? "status" : "percent";
  $("kPredictionAutoOpenThresholdPercent").value = String(d.kPredictionAutoOpenThresholdPercent);
  $("kPredictionAutoOpenDecision").value = d.kPredictionAutoOpenDecision || "BUY_CANDIDATE";
  $("kPredictionAutoBuyEnabled").checked = !!d.kPredictionAutoBuyEnabled;
  $("kPredictionAutoBuyTriggerMode").value = d.kPredictionAutoBuyTriggerMode === "status" ? "status" : "percent";
  $("kPredictionAutoBuyThresholdPercent").value = String(d.kPredictionAutoBuyThresholdPercent);
  $("kPredictionAutoBuyDecision").value = d.kPredictionAutoBuyDecision || "BUY_CANDIDATE";
  $("kPredictionBuySpeechEnabled").checked = !!d.kPredictionBuySpeechEnabled;
  $("kPredictionRatingCheckerEnabled").checked = !!d.kPredictionRatingCheckerEnabled;
  $("kPredictionRatingCheckerTriggerMode").value = d.kPredictionRatingCheckerTriggerMode === "status" ? "status" : "percent";
  $("kPredictionRatingCheckerThresholdPercent").value = String(d.kPredictionRatingCheckerThresholdPercent);
  $("kPredictionRatingCheckerDecision").value = d.kPredictionRatingCheckerDecision || "BUY_CANDIDATE";
  Object.keys(CONDITION_GROUPS).forEach(updateConditionVisibility);
  fillSoundSelects();
  for (const f of SOUND_FIELDS) {
    $(f.enabled).checked = !!d[f.enabled];
    $(f.name).value = d[f.name] || f.fallback;
  }

  $("positionThreshold").value = String(d.positionThreshold);
  $("reuseThreshold").value = String(d.reuseThreshold);
  $("quickBuyFeesEnabled").checked = d.quickBuyFeesEnabled !== false;
  $("showDevVolume").checked = d.showDevVolume !== false;
  $("showDevPreviousLaunch").checked = d.showDevPreviousLaunch !== false;
  $("showTwitterVolume").checked = d.showTwitterVolume !== false;
  $("showTwitterPreviousLaunch").checked = d.showTwitterPreviousLaunch !== false;
  $("showUpdateBDelay").checked = d.showUpdateBDelay !== false;
  $("feeTokenCount").value = String(d.feeTokenCount);
  $("feeHighlightThreshold").value = String(d.feeHighlightThreshold);
  $("feeHighlightColor").value = d.feeHighlightColor || DEFAULTS.feeHighlightColor;
  $("showTrustBadge").checked = d.showTrustBadge !== false;
  $("showDevVolBadge").checked = d.showDevVolBadge !== false;
  $("showTwitterVolBadge").checked = d.showTwitterVolBadge !== false;
  $("devVolBadgeThreshold").value = String(d.devVolBadgeThreshold ?? d.combinedVolThreshold);
  $("devVolBadgeColor").value = d.devVolBadgeColor || DEFAULTS.devVolBadgeColor;
  $("twitterVolBadgeThreshold").value = String(d.twitterVolBadgeThreshold ?? d.combinedVolThreshold);
  $("twitterVolBadgeColor").value = d.twitterVolBadgeColor || DEFAULTS.twitterVolBadgeColor;

}

// ---------------------------------------------------------------- save

async function saveAll() {
  const serverUrl = await prepareServer();
  if (serverUrl === null) return;
  const devWhitelist = parseLines(devWlEl.value, normalizeDev);
  const twitterWhitelist = parseLines(twitterWlEl.value, normalizeHandle);
  // Write the cleaned lists back so the boxes show exactly what was stored.
  devWlEl.value = devWhitelist.join("\n");
  twitterWlEl.value = twitterWhitelist.join("\n");
  renderWlCounts();

  const payload = {
    msfServerUrl: serverUrl,
    msfWsToken: wsTokenEl.value.trim(),
    devWhitelist,
    twitterWhitelist,

    kPredictionAutoOpenEnabled: $("kPredictionAutoOpenEnabled").checked,
    kPredictionAutoOpenTriggerMode: $("kPredictionAutoOpenTriggerMode").value,
    kPredictionAutoOpenThresholdPercent: Math.min(100, num("kPredictionAutoOpenThresholdPercent", 8, 0)),
    kPredictionAutoOpenDecision: $("kPredictionAutoOpenDecision").value,
    kPredictionAutoBuyEnabled: $("kPredictionAutoBuyEnabled").checked,
    kPredictionAutoBuyTriggerMode: $("kPredictionAutoBuyTriggerMode").value,
    kPredictionAutoBuyThresholdPercent: Math.min(100, num("kPredictionAutoBuyThresholdPercent", 8, 0)),
    kPredictionAutoBuyDecision: $("kPredictionAutoBuyDecision").value,
    kPredictionBuySpeechEnabled: $("kPredictionBuySpeechEnabled").checked,
    kPredictionRatingCheckerEnabled: $("kPredictionRatingCheckerEnabled").checked,
    kPredictionRatingCheckerTriggerMode: $("kPredictionRatingCheckerTriggerMode").value,
    kPredictionRatingCheckerThresholdPercent: Math.min(100, num("kPredictionRatingCheckerThresholdPercent", 8, 0)),
    kPredictionRatingCheckerDecision: $("kPredictionRatingCheckerDecision").value,

    positionThreshold: num("positionThreshold", 1, 0),
    reuseThreshold: num("reuseThreshold", 1, 0),
    quickBuyFeesEnabled: $("quickBuyFeesEnabled").checked,
    showDevVolume: $("showDevVolume").checked,
    showDevPreviousLaunch: $("showDevPreviousLaunch").checked,
    showTwitterVolume: $("showTwitterVolume").checked,
    showTwitterPreviousLaunch: $("showTwitterPreviousLaunch").checked,
    showUpdateBDelay: $("showUpdateBDelay").checked,
    feeTokenCount: num("feeTokenCount", 5, 1),
    feeHighlightThreshold: num("feeHighlightThreshold", 0, 0),
    feeHighlightColor: $("feeHighlightColor").value,
    showTrustBadge: $("showTrustBadge").checked,
    showDevVolBadge: $("showDevVolBadge").checked,
    showTwitterVolBadge: $("showTwitterVolBadge").checked,
    devVolBadgeThreshold: num("devVolBadgeThreshold", 0, 0),
    devVolBadgeColor: $("devVolBadgeColor").value,
    twitterVolBadgeThreshold: num("twitterVolBadgeThreshold", 0, 0),
    twitterVolBadgeColor: $("twitterVolBadgeColor").value,

  };

  for (const f of SOUND_FIELDS) {
    payload[f.enabled] = $(f.enabled).checked;
    payload[f.name] = $(f.name).value || f.fallback;
  }

  await chrome.storage.local.set(payload);

  saveEl.classList.add("ok");
  saveEl.textContent = "Saved";
  setTimeout(() => {
    saveEl.classList.remove("ok");
    saveEl.textContent = "Save settings";
  }, 1000);
}

saveEl.addEventListener("click", saveAll);
for (const [group, id] of Object.entries(CONDITION_GROUPS)) {
  $(id).addEventListener("change", () => updateConditionVisibility(group));
}
document.addEventListener("keydown", (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key === "s") {
    e.preventDefault();
    saveAll();
  }
});

devWlEl.addEventListener("input", renderWlCounts);
twitterWlEl.addEventListener("input", renderWlCounts);

// ---------------------------------------------------------------- connection

function setStatus(status, error) {
  lastWsStatus = status || "disconnected";
  statusEl.className = "status " + lastWsStatus;
  if (status === "connecting") { statusEl.textContent = "Connecting…"; return; }
  if (status === "connected") { statusEl.textContent = "Connected"; return; }
  if (status === "error") { statusEl.textContent = error ? "Error" : "Error"; return; }
  statusEl.textContent = "Disconnected";
}

function connectionError(message) {
  const error = $("connectionError");
  error.textContent = message;
  error.hidden = !message;
}

async function prepareServer() {
  try {
    const serverUrl = BlackCarrotServer.normalize(serverAddressEl.value);
    if (serverUrl) {
      const granted = await chrome.permissions.request({ origins: [BlackCarrotServer.permission(serverUrl)] });
      if (!granted) throw new Error("Allow access to the server to connect.");
    }
    connectionError("");
    return serverUrl;
  } catch (error) {
    connectionError(error.message || "Invalid server address");
    return null;
  }
}

async function saveToken() {
  await chrome.storage.local.set({ msfWsToken: wsTokenEl.value.trim() });
}

// A popup is dismissed by clicking anywhere outside it, which is far too easy
// to do after pasting a key.
wsTokenEl.addEventListener("blur", saveToken);

$("connect").addEventListener("click", async () => {
  const serverUrl = await prepareServer();
  if (serverUrl === null) return;
  if (!serverUrl) { connectionError("Enter the server address."); return; }
  if (!wsTokenEl.value.trim()) {
    setStatus("error", "Token is not set");
    return;
  }
  await chrome.storage.local.set({ msfServerUrl: serverUrl, msfWsToken: wsTokenEl.value.trim() });
  chrome.runtime.sendMessage({ type: "WS_CONNECT" });
  statusEl.textContent = "Connecting…";
});

$("disconnect").addEventListener("click", () => {
  chrome.runtime.sendMessage({ type: "WS_DISCONNECT" });
  setStatus("disconnected");
});

// sidePanel.open needs a user gesture; this click is one. Falls back to a tab
// where the API is missing.
$("openChecker").addEventListener("click", async () => {
  try {
    if (chrome.sidePanel?.open) {
      const win = await chrome.windows.getCurrent();
      await chrome.sidePanel.open({ windowId: win.id });
      window.close();
      return;
    }
  } catch {
    // fall through to the tab
  }
  chrome.tabs.create({ url: chrome.runtime.getURL("checker.html") });
});

// Preview a tone through background, so it uses the same player a real alert
// does and works with no axiom.trade tab open.
for (const btn of document.querySelectorAll("[data-play]")) {
  btn.addEventListener("click", () => {
    const preset = $(btn.dataset.play)?.value;
    if (!preset) return;
    chrome.runtime.sendMessage({ type: "PLAY_SOUND_PREVIEW", preset });
  });
}

chrome.runtime.onMessage.addListener((msg) => {
  if (msg?.type === "WS_STATUS") setStatus(msg.status, msg.error);
});

chrome.runtime.sendMessage({ type: "WS_STATUS_REQ" });
load();
