// Direct connection to the MSF feed. Historically the extension talked to a
// local relay (ws://127.0.0.1:8765) fed by the macOS app; now it connects to
// the upstream server itself and does the whitelist matching that
// the macOS app used to do.

importScripts("server-config.js");
// Apply the requested volume thresholds once; later user changes are retained.
async function applyVolumeThresholdPreset() {
  const { volumeThresholdPreset10000 } = await chrome.storage.local.get("volumeThresholdPreset10000");
  if (volumeThresholdPreset10000) return;
  await chrome.storage.local.set({
    devVolBadgeThreshold: 10000,
    twitterVolBadgeThreshold: 10000,
    volumeThresholdPreset10000: true,
  });
}
applyVolumeThresholdPreset().catch((error) => console.warn("Volume threshold settings:", error));

let serverBaseUrl = "";
const K_PREDICTION_PREDICT_URL = "http://127.0.0.1:8011/predict";
const K_PREDICTION_PREDICT_TIMEOUT_MS = 10000;

// Matches the macOS client (5 tries, 2s apart) rather than the old 3/1.5s the
// local relay used — the upstream link is worth retrying harder.
const MAX_RECONNECT_ATTEMPTS = 5;
const RECONNECT_DELAY_MS = 2000;

let ws = null;
let wsConnectionGeneration = 0;
let reconnectTimer = null;
let lastStatus = "disconnected";
let shouldReconnect = false;
let lastError = null;
let reconnectAttempts = 0;
let kPredictionAutoBuyClaims = null;
let kPredictionAutoBuyClaimsLoading = null;
const K_PREDICTION_AUTO_BUY_CLAIMS_KEY = "kPredictionAutoBuyClaimedTokens";
const K_PREDICTION_AUTO_BUY_CLAIMS_MAX = 1000;

async function loadKPredictionAutoBuyClaims() {
  if (kPredictionAutoBuyClaims) return kPredictionAutoBuyClaims;
  if (!kPredictionAutoBuyClaimsLoading) {
    kPredictionAutoBuyClaimsLoading = chrome.storage.session
      .get({ [K_PREDICTION_AUTO_BUY_CLAIMS_KEY]: [] })
      .then((stored) => {
        const values = Array.isArray(stored[K_PREDICTION_AUTO_BUY_CLAIMS_KEY])
          ? stored[K_PREDICTION_AUTO_BUY_CLAIMS_KEY]
          : [];
        kPredictionAutoBuyClaims = new Set(values.map((value) => String(value || "")).filter(Boolean));
        return kPredictionAutoBuyClaims;
      });
  }
  return kPredictionAutoBuyClaimsLoading;
}

async function claimKPredictionAutoBuy(tokenAddress) {
  const claims = await loadKPredictionAutoBuyClaims();
  if (claims.has(tokenAddress)) return false;
  claims.add(tokenAddress);
  const values = Array.from(claims);
  if (values.length > K_PREDICTION_AUTO_BUY_CLAIMS_MAX) {
    const excess = values.length - K_PREDICTION_AUTO_BUY_CLAIMS_MAX;
    for (const oldToken of values.slice(0, excess)) claims.delete(oldToken);
  }
  await chrome.storage.session.set({ [K_PREDICTION_AUTO_BUY_CLAIMS_KEY]: Array.from(claims) });
  return true;
}

async function releaseKPredictionAutoBuyClaim(tokenAddress) {
  const claims = await loadKPredictionAutoBuyClaims();
  if (!claims.delete(tokenAddress)) return;
  await chrome.storage.session.set({ [K_PREDICTION_AUTO_BUY_CLAIMS_KEY]: Array.from(claims) });
}

async function dispatchNativeAxiomClick(tabId, point) {
  const target = { tabId };
  let attached = false;
  try {
    await chrome.debugger.attach(target, "1.3");
    attached = true;
    const params = {
      x: point.x,
      y: point.y,
      button: "left",
      buttons: 1,
      clickCount: 1,
      pointerType: "mouse",
    };
    await chrome.debugger.sendCommand(target, "Input.dispatchMouseEvent", {
      ...params,
      type: "mouseMoved",
      button: "none",
      buttons: 0,
    });
    await chrome.debugger.sendCommand(target, "Input.dispatchMouseEvent", {
      ...params,
      type: "mousePressed",
    });
    await chrome.debugger.sendCommand(target, "Input.dispatchMouseEvent", {
      ...params,
      type: "mouseReleased",
      buttons: 0,
    });
  } finally {
    if (attached) {
      try {
        await chrome.debugger.detach(target);
      } catch { /* the tab may have navigated after Quick Buy */ }
    }
  }
}

// ---------------------------------------------------------------- settings

let wsToken = "";
let devWhitelist = new Set();
let twitterWhitelist = new Set();
let kPredictionRatingCheckerEnabled = false;
let kPredictionRatingCheckerTriggerMode = "percent";
let kPredictionRatingCheckerThresholdPercent = 8;
let kPredictionRatingCheckerDecision = "BUY_CANDIDATE";
let spokenKPredictionTokens = null;
let spokenKPredictionTokensLoading = null;
const K_PREDICTION_SPOKEN_TOKENS_KEY = "kPredictionRatingSpokenTokens";
const K_PREDICTION_SPOKEN_TOKENS_MAX = 1000;
let soundSettings = {
  dev: { enabled: false, name: "soft" },
  tw: { enabled: false, name: "ding" },
  both: { enabled: true, name: "rise" },
};

const SETTINGS_DEFAULTS = {
  msfServerUrl: "",
  msfWsToken: "",
  devWhitelist: [],
  twitterWhitelist: [],
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
};

function isEvmAddress(value) {
  return /^0x[0-9a-fA-F]{40}$/.test(String(value || ""));
}

// SOL addresses are case-sensitive base58, EVM ones are not.
function normalizeDevAddress(value) {
  const str = String(value || "").trim();
  if (!str) return "";
  return isEvmAddress(str) ? str.toLowerCase() : str;
}

function matchTwitterWhitelist(content) {
  const currentHandle = String(
    content?.twitter_handle ?? content?.twitterHandle ?? ""
  ).trim();
  if (currentHandle && twitterWhitelist.has(currentHandle)) {
    return { matched: true, historyIndex: 0 };
  }

  const history = content?.twitter_handle_history ?? content?.twitterHandleHistory;
  if (!Array.isArray(history)) return { matched: false, historyIndex: 0 };
  for (let index = 0; index < history.length; index += 1) {
    const item = history[index];
    const handle = String(
      item && typeof item === "object" ? item.handle ?? "" : item ?? ""
    ).trim();
    if (handle && twitterWhitelist.has(handle)) {
      return { matched: true, historyIndex: index + 1 };
    }
  }
  return { matched: false, historyIndex: 0 };
}

function applySettings(data) {
  try { serverBaseUrl = BlackCarrotServer.normalize(data.msfServerUrl); }
  catch { serverBaseUrl = ""; }
  wsToken = String(data.msfWsToken || "").trim();
  devWhitelist = new Set(
    (Array.isArray(data.devWhitelist) ? data.devWhitelist : [])
      .map(normalizeDevAddress)
      .filter(Boolean)
  );
  // Handles are stored verbatim (no @-stripping) and compared exactly.
  twitterWhitelist = new Set(
    (Array.isArray(data.twitterWhitelist) ? data.twitterWhitelist : [])
      .map((v) => String(v || "").trim())
      .filter(Boolean)
  );
  kPredictionRatingCheckerEnabled = !!data.kPredictionRatingCheckerEnabled;
  kPredictionRatingCheckerTriggerMode = data.kPredictionRatingCheckerTriggerMode === "status" ? "status" : "percent";
  kPredictionRatingCheckerDecision = String(data.kPredictionRatingCheckerDecision || "BUY_CANDIDATE").toUpperCase();
  const checkerThreshold = Number(data.kPredictionRatingCheckerThresholdPercent);
  kPredictionRatingCheckerThresholdPercent = Number.isFinite(checkerThreshold)
    ? Math.min(100, Math.max(0, checkerThreshold))
    : 8;
  soundSettings = {
    dev: { enabled: !!data.soundDevOnlyEnabled, name: data.soundDevOnlyName || "soft" },
    tw: { enabled: !!data.soundTwitterOnlyEnabled, name: data.soundTwitterOnlyName || "ding" },
    both: { enabled: !!data.soundBothEnabled, name: data.soundBothName || "rise" },
  };
}

async function loadSettings() {
  const data = await chrome.storage.local.get(SETTINGS_DEFAULTS);
  applySettings(data);
}

loadSettings();

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local") return;
  if (changes.msfServerUrl) {
    disconnectWs();
  }
  const touched = Object.keys(SETTINGS_DEFAULTS).some((k) => k in changes);
  if (touched) loadSettings();
});

// ---------------------------------------------------------------- messaging

function broadcastUpdate(payload) {
  chrome.tabs.query({ url: ["https://*.axiom.trade/*"] }, (tabs) => {
    for (const tab of tabs) {
      if (!tab.id) continue;
      chrome.tabs.sendMessage(tab.id, { type: "WS_LOCAL_UPDATE", payload }, () => {
        if (chrome.runtime.lastError) return;
      });
    }
  });
}

function broadcastStatus(status, error) {
  chrome.runtime.sendMessage({ type: "WS_STATUS", status, error }, () => {
    if (chrome.runtime.lastError) return;
  });
  chrome.tabs.query({ url: ["https://*.axiom.trade/*"] }, (tabs) => {
    for (const tab of tabs) {
      if (!tab.id) continue;
      chrome.tabs.sendMessage(tab.id, { type: "WS_STATUS", status, error }, () => {
        if (chrome.runtime.lastError) return;
      });
    }
  });
}

function setStatus(status, error) {
  lastStatus = status;
  lastError = error || null;
  broadcastStatus(status, lastError);
}

// ---------------------------------------------------------------- connection

function scheduleReconnect() {
  if (reconnectTimer) return;
  if (!shouldReconnect) return;
  if (reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) {
    shouldReconnect = false;
    setStatus("disconnected", lastError || "Connection failed");
    return;
  }
  reconnectAttempts += 1;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    if (shouldReconnect) connectWs();
  }, RECONNECT_DELAY_MS);
}

async function connectWs() {
  const generation = ++wsConnectionGeneration;
  await loadSettings();
  if (generation !== wsConnectionGeneration || !shouldReconnect) return;

  if (!serverBaseUrl) {
    shouldReconnect = false;
    setStatus("error", "Server address is not set");
    return;
  }

  if (!wsToken) {
    shouldReconnect = false;
    setStatus("error", "Token is not set");
    return;
  }

  if (ws) {
    ws.onopen = null;
    ws.onclose = null;
    ws.onmessage = null;
    ws.onerror = null;
    ws.close();
    ws = null;
  }

  setStatus("connecting", null);

  const connectionKey = wsToken;
  const connectionBase = serverBaseUrl;
  let ticket;
  try {
    const response = await fetch(`${connectionBase}/ws/ticket`, {
      method: "POST",
      headers: { Authorization: `Bearer ${connectionKey}` },
      cache: "no-store",
      signal: AbortSignal.timeout(10000),
    });
    if (generation !== wsConnectionGeneration || !shouldReconnect) return;
    if (response.status === 401 || response.status === 403) {
      shouldReconnect = false;
      setStatus("error", response.status === 401 ? "Key expired, revoked or invalid" : "WebSocket access denied");
      return;
    }
    if (!response.ok) throw new Error(`Connection authorization failed (${response.status})`);
    const result = await response.json();
    if (typeof result.ticket !== "string" || !result.ticket || result.ticket.length > 128) {
      throw new Error("Invalid connection ticket");
    }
    ticket = result.ticket;
  } catch (error) {
    if (generation !== wsConnectionGeneration || !shouldReconnect) return;
    setStatus("error", error instanceof Error ? error.message : "Connection authorization failed");
    scheduleReconnect();
    return;
  }
  if (generation !== wsConnectionGeneration || !shouldReconnect) return;
  if (wsToken !== connectionKey || serverBaseUrl !== connectionBase) { connectWs(); return; }
  const url = `${BlackCarrotServer.websocket(connectionBase)}/ws?ticket=${encodeURIComponent(ticket)}`;
  ws = new WebSocket(url);

  ws.onopen = () => {
    reconnectAttempts = 0;
    setStatus("connected", null);
  };

  ws.onclose = (event) => {
    if (event && event.reason) lastError = event.reason;
    setStatus("disconnected", lastError);
    scheduleReconnect();
  };

  ws.onerror = () => {
    // The error event carries no useful detail in the WS API; onclose follows
    // and drives the reconnect.
    setStatus("error", "Connection error");
  };

  ws.onmessage = (event) => {
    const text = typeof event.data === "string" ? event.data : "";

    // The upstream server speaks plain-text keep-alive. This must run BEFORE
    // JSON.parse — JSON.parse("ping") throws and the reply would never be sent.
    if (text === "ping") {
      try { ws.send("pong"); } catch { /* socket already closing */ }
      return;
    }
    if (text === "pong") return;

    let data = null;
    try {
      data = JSON.parse(text);
    } catch {
      return;
    }
    if (!data || typeof data !== "object") return;

    // JSON keep-alive, as spoken by the old local relay. Harmless to keep.
    if (data.type === "ping") {
      try { ws.send(JSON.stringify({ type: "pong" })); } catch { /* closing */ }
      return;
    }
    if (data.type === "pong") return;

    handleServerMessage(data, text);
  };
}

function disconnectWs() {
  ++wsConnectionGeneration;
  shouldReconnect = false;
  reconnectAttempts = 0;
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
  if (ws) {
    ws.onopen = null;
    ws.onclose = null;
    ws.onmessage = null;
    ws.onerror = null;
    ws.close();
    ws = null;
  }
  setStatus("disconnected", null);
}

// ---------------------------------------------------------------- feed

const FEED_TYPES = new Set([
  "sol_update_a",
  "sol_update_b",
  "bnb_dev_update",
  "bnb_social_update",
]);

function handleServerMessage(data, rawText) {
  if (!FEED_TYPES.has(data.type)) return;

  // Capture receipt before any matching, cache or prediction work so the
  // displayed latency measures the wire arrival of update_b, not our UI work.
  const receivedAtMs = Date.now();
  const updateBTiming = data.type === "sol_update_b"
    ? buildUpdateBTiming(data, receivedAtMs)
    : null;

  const devAddress = normalizeDevAddress(data.deployer_address ?? data.dev_address);
  const devMatch = !!devAddress && devWhitelist.has(devAddress);
  const twitterMatch = matchTwitterWhitelist(data);
  const twMatch = twitterMatch.matched;
  const matchType = devMatch && twMatch ? "both" : twMatch ? "tw" : devMatch ? "dev" : null;

  const tokenKey = String(data.token_address || "").toLowerCase();
  const pairKey = String(data.pair_address || "").toLowerCase();

  // Read the previous match BEFORE storeWsInMem overwrites it, so a pair whose
  // match is upgraded (dev -> both once update_b brings the handle) still fires.
  const seen =
    (pairKey && wsMem.get(`pair:${pairKey}`)) ||
    (tokenKey && wsMem.get(`token:${tokenKey}`)) ||
    null;
  const prevMatch = seen?.meta?.match_type ?? null;
  if (matchType && matchType !== prevMatch) playMatchSound(matchType);

  // The envelope injected.js expects: flags at the top level, `raw` a STRING.
  const envelope = {
    type: data.type,
    trigger_reason: "",
    dev_wl: devMatch,
    twitter_wl: twMatch,
    twitter_wl_history_index: twitterMatch.historyIndex,
    token_address: data.token_address || "",
    pair_address: data.pair_address || "",
    ...(updateBTiming || {}),
    raw: rawText,
  };

  if (data.type === "sol_update_a" || data.type === "sol_update_b") {
    storeWsInMem(envelope, matchType);
  }
  broadcastUpdate(envelope);

  maybeResolveKPrediction(data);
}

function parseEventTimestampMs(value) {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value === "string" && !/^\d+(?:\.\d+)?$/.test(value.trim())) {
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  let numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0) return null;
  // Accept epoch seconds, milliseconds, microseconds and nanoseconds.
  if (numeric < 1e11) numeric *= 1000;
  else if (numeric >= 1e17) numeric /= 1e6;
  else if (numeric >= 1e14) numeric /= 1000;
  return Number.isFinite(numeric) ? numeric : null;
}

function buildUpdateBTiming(content, receivedAtMs) {
  // These are token/pair launch timestamps only. Do not recursively inspect
  // the payload: tweet/account and previous-token dates can be much older.
  const candidates = [
    content.created_at,
    content.createdAt,
    content.token_created_at,
    content.tokenCreatedAt,
    content.pair_created_at,
    content.pairCreatedAt,
    content.launch_at,
    content.launched_at,
    content.launch_time,
  ]
    .map(parseEventTimestampMs)
    .filter((value) => Number.isFinite(value) && value <= receivedAtMs + 5000);
  if (!candidates.length) return null;
  const launchAtMs = Math.min(...candidates);
  return {
    update_b_delay_seconds: Math.max(0, receivedAtMs - launchAtMs) / 1000,
    update_b_received_at: new Date(receivedAtMs).toISOString(),
    token_launch_at: new Date(launchAtMs).toISOString(),
  };
}

const wsMem = new Map();
const WS_MEM_MAX = 200;

// Snapshot of a token for the token-page overlay, which reads this cache rather
// than the live feed.
//
// Absent keys are omitted rather than set to undefined. sol_update_a and
// sol_update_b each carry only part of the picture, and the entries are merged
// by spreading the new snapshot over the stored one — and a spread does NOT
// skip undefined, it overwrites with it. Emitting every key unconditionally
// meant update_b, which often has no dev_volume_usd or previous_tokens, wiped
// the values update_a had just supplied, so the overlay lost the dev figures.
// ingestVolumePayload in injected.js merges with ?? for exactly this reason.
function pickMinimal(content) {
  const out = {};
  if (!content || typeof content !== "object") return out;
  const put = (key, value) => {
    if (value !== undefined && value !== null) out[key] = value;
  };

  put("pair_address", content.pair_address ?? content.pairAddress);
  put("token_address", content.token_address ?? content.tokenAddress);
  put("token_name", content.token_name ?? content.tokenName);
  put("token_ticker", content.token_ticker ?? content.tokenTicker);
  put("deployer_address", content.deployer_address ?? content.dev_address);
  put("created_at", content.created_at);

  put("dev_volume_usd", content.dev_volume_usd);
  if (typeof content.trust_qualified === "boolean") put("trust_qualified", content.trust_qualified);
  put("dev_score", content.dev_score);
  put("migrate_prc", content.migrate_prc);
  put("total_tokens", content.total_tokens);
  put("migrated_tokens", content.migrated_tokens);
  put("last_migration_at", content.last_migration_at);
  put("avg_ath_cap", content.avg_ath_cap);
  put("initial_liquidity_sol", content.initial_liquidity_sol);
  put("supply", content.supply);

  put("twitter_handle", content.twitter_handle ?? content.twitterHandle);
  put("all_twitter_volume_usd", content.all_twitter_volume_usd);
  put("sol_twitter_volume_usd", content.sol_twitter_volume_usd);
  put("bnb_twitter_volume_usd", content.bnb_twitter_volume_usd);
  put("twitter_total_tokens", content.twitter_total_tokens);
  put("twitter_total_migrations", content.twitter_total_migrations);
  put("name_ticker_usage", content.name_ticker_usage);
  put("twitter_publication_context", content.twitter_publication_context);
  put("twitter_monthly_analytics", content.twitter_monthly_analytics);
  put("twitter_devs_qualified", content.twitter_devs_qualified);
  put("dev_wallet_funding", content.dev_wallet_funding);

  // twitter_data is deliberately left out: it carries bios and full tweet text,
  // and this cache holds hundreds of tokens in worker memory.
  if (Array.isArray(content.previous_tokens)) {
    out.previous_tokens = content.previous_tokens.slice(0, 10).map((t) => ({
      tokenAddress: t?.tokenAddress,
      tokenName: t?.tokenName,
      tokenTicker: t?.tokenTicker,
      // Drives the "time since the dev's previous launch" label.
      createdAt: t?.createdAt,
      fee: t?.fee,
      global_fee: t?.global_fee,
      volume: t?.volume,
      migrated: t?.migrated,
      marketCap: t?.marketCap,
      maxMarketCap: t?.maxMarketCap,
    }));
  }
  return out;
}

function storeWsInMem(data, matchType) {
  // Envelopes carry the token payload as a JSON string in `raw`.
  let content;
  if (data.content && typeof data.content === "object") {
    content = data.content;
  } else if (data.raw && typeof data.raw === "string") {
    try {
      const inner = JSON.parse(data.raw);
      content = inner && typeof inner === "object" ? inner : data;
    } catch { content = data; }
  } else {
    content = data;
  }
  const token = (content.token_address || content.tokenAddress || data.token_address || "").toLowerCase();
  const pair = (content.pair_address || content.pairAddress || data.pair_address || "").toLowerCase();
  if (!token && !pair) return;
  const minimal = pickMinimal(content);
  if (Number.isFinite(data.update_b_delay_seconds)) {
    minimal.update_b_delay_seconds = data.update_b_delay_seconds;
    minimal.update_b_received_at = data.update_b_received_at;
    minimal.token_launch_at = data.token_launch_at;
  }
  const prev =
    (pair && wsMem.get(`pair:${pair}`)) ||
    (token && wsMem.get(`token:${token}`)) ||
    null;
  const preserveB = prev?.type === "sol_update_b" && data.type === "sol_update_a";
  const entry = {
    type: preserveB ? prev.type : data.type,
    // Safe only because pickMinimal omits absent keys instead of emitting
    // undefined — a spread would otherwise overwrite with them.
    content: preserveB ? { ...minimal, ...prev.content } : { ...(prev?.content || {}), ...minimal },
    meta: {
      dev_wl: data.dev_wl ?? prev?.meta?.dev_wl,
      twitter_wl: data.twitter_wl ?? prev?.meta?.twitter_wl,
      twitter_wl_history_index:
        data.twitter_wl_history_index ?? prev?.meta?.twitter_wl_history_index ?? 0,
      trigger_reason: data.trigger_reason ?? prev?.meta?.trigger_reason,
      match_type: matchType ?? prev?.meta?.match_type ?? null,
    },
    ts: Date.now(),
  };
  if (pair) wsMem.set(`pair:${pair}`, entry);
  if (token) wsMem.set(`token:${token}`, entry);
  if (wsMem.size > WS_MEM_MAX * 2) {
    const sorted = [...wsMem.entries()].sort((a, b) => (a[1].ts || 0) - (b[1].ts || 0));
    for (const [k] of sorted.slice(0, wsMem.size - WS_MEM_MAX * 2)) wsMem.delete(k);
  }
}

// ---------------------------------------------------------------- KPrediction predictor

// Show a preliminary KPrediction score from sol_update_a as soon as possible, then
// replace it with the richer sol_update_b score. Requests for A and B can finish
// out of order, so an A answer must never overwrite an already applied B answer.
// The local API is optional: when it is offline the feed continues normally.
const K_PREDICTION_UPDATE_RANK = { sol_update_a: 1, sol_update_b: 2 };
const kPredictionRequestVersion = new Map();
const kPredictionAppliedRank = new Map();
const K_PREDICTION_REQUEST_VERSION_MAX = 300;
let kPredictionCacheState = null;
let kPredictionCacheLoading = null;
let kPredictionCacheWriteTimer = null;
let kPredictionCacheWriteInFlight = Promise.resolve();
const K_PREDICTION_CACHE_WRITE_DELAY_MS = 250;

function nextKPredictionRequestVersion(tokenAddress, rank) {
  const tokenKey = String(tokenAddress || "").toLowerCase();
  const requestKey = `${tokenKey}:${rank}`;
  const version = (kPredictionRequestVersion.get(requestKey) || 0) + 1;
  kPredictionRequestVersion.delete(requestKey);
  kPredictionRequestVersion.set(requestKey, version);
  if (kPredictionRequestVersion.size > K_PREDICTION_REQUEST_VERSION_MAX) {
    const oldest = kPredictionRequestVersion.keys().next().value;
    if (oldest !== undefined) kPredictionRequestVersion.delete(oldest);
  }
  return { tokenKey, requestKey, version };
}

async function maybeResolveKPrediction(data) {
  const rank = K_PREDICTION_UPDATE_RANK[data.type];
  if (!rank) return;
  const tokenAddress = String(data.token_address || "");
  if (!tokenAddress) return;
  const { tokenKey, requestKey, version } = nextKPredictionRequestVersion(tokenAddress, rank);

  try {
    let prediction;
    if (data.k_prediction_provider === "server") {
      // The server owns inference, including deferred retries. Missing results
      // must not trigger a competing local prediction or a fake zero.
      prediction = data.k_prediction;
    } else {
      const res = await fetch(K_PREDICTION_PREDICT_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          input: data,
          observed_at: new Date().toISOString(),
          include_narrative: false,
        }),
        signal: AbortSignal.timeout(K_PREDICTION_PREDICT_TIMEOUT_MS),
      });
      if (!res.ok) return;
      prediction = await res.json();
    }
    if (!prediction || typeof prediction !== "object") return;
    if (kPredictionRequestVersion.get(requestKey) !== version) return;
    if ((kPredictionAppliedRank.get(tokenKey) || 0) > rank) return;

    const decision = String(prediction.selection_decision || "").toUpperCase();
    const probability = (prediction?.probability ?? prediction?.p_k_buy);
    if (!["BUY_CANDIDATE", "WATCH", "SKIP"].includes(decision)) return;
    if (typeof probability !== "number" || !Number.isFinite(probability) || probability < 0 || probability > 1) return;

    const payload = {
      type: "k_prediction",
      token_address: tokenAddress,
      pair_address: String(data.pair_address || ""),
      token_name: String(data.token_name || data.token_ticker || ""),
      update_type: data.type,
      preliminary: data.type === "sol_update_a",
      prediction: {
        decision,
        probability,
        threshold: prediction.threshold,
        model_kind: prediction.model_kind,
        latency_ms: prediction.latency_ms,
      },
    };
    kPredictionAppliedRank.delete(tokenKey);
    kPredictionAppliedRank.set(tokenKey, rank);
    if (kPredictionAppliedRank.size > K_PREDICTION_REQUEST_VERSION_MAX) {
      const oldest = kPredictionAppliedRank.keys().next().value;
      if (oldest !== undefined) kPredictionAppliedRank.delete(oldest);
    }
    // Rendering and actions must not wait for chrome.storage. The KPrediction
    // cache is a convenience for reloads, but rewriting its full object can
    // occasionally take seconds when Chrome's extension LevelDB is busy.
    broadcastUpdate(payload);
    await maybeSpeakKPredictionChecker(payload);
    storeKPrediction(payload).catch(() => {});
  } catch {
    // The predictor is a local optional enhancement; stay silent when offline.
  }
}

async function claimKPredictionSpeech(tokenAddress) {
  if (!spokenKPredictionTokensLoading) {
    spokenKPredictionTokensLoading = chrome.storage.session
      .get({ [K_PREDICTION_SPOKEN_TOKENS_KEY]: [] })
      .then((stored) => {
        const values = Array.isArray(stored[K_PREDICTION_SPOKEN_TOKENS_KEY])
          ? stored[K_PREDICTION_SPOKEN_TOKENS_KEY]
          : [];
        spokenKPredictionTokens = new Set(values.map((value) => String(value || "")).filter(Boolean));
        return spokenKPredictionTokens;
      });
  }
  const tokens = await spokenKPredictionTokensLoading;
  if (tokens.has(tokenAddress)) return false;
  tokens.add(tokenAddress);
  while (tokens.size > K_PREDICTION_SPOKEN_TOKENS_MAX) {
    tokens.delete(tokens.values().next().value);
  }
  await chrome.storage.session.set({ [K_PREDICTION_SPOKEN_TOKENS_KEY]: Array.from(tokens) });
  return true;
}

async function maybeSpeakKPredictionChecker(payload) {
  if (payload?.preliminary) return;
  if (!kPredictionRatingCheckerEnabled) return;
  const tokenAddress = String(payload?.token_address || "");
  const probability = Number(payload?.prediction?.probability);
  const decision = String(payload?.prediction?.decision || "").toUpperCase();
  if (!tokenAddress) return;
  if (!Number.isFinite(probability) || probability < 0 || probability > 1) return;
  const percent = probability * 100;
  const decisionRank = { SKIP: 0, WATCH: 1, BUY_CANDIDATE: 2 };
  const matches = kPredictionRatingCheckerTriggerMode === "status"
    ? Number.isInteger(decisionRank[decision]) &&
      Number.isInteger(decisionRank[kPredictionRatingCheckerDecision]) &&
      decisionRank[decision] >= decisionRank[kPredictionRatingCheckerDecision]
    : percent >= kPredictionRatingCheckerThresholdPercent;
  if (!matches) return;
  if (!(await claimKPredictionSpeech(tokenAddress))) return;
  speakKPredictionRating(Number(percent.toFixed(2)), payload.token_name);
}

async function storeKPrediction(data) {
  const token = String(data.token_address || "").toLowerCase();
  const pair = String(data.pair_address || "").toLowerCase();
  if (!token && !pair) return;
  if (!kPredictionCacheLoading) {
    kPredictionCacheLoading = chrome.storage.local
      .get({ kPredictionCache: {} })
      .then((stored) => {
        kPredictionCacheState = stored.kPredictionCache || {};
        return kPredictionCacheState;
      });
  }
  const cache = await kPredictionCacheLoading;
  const entry = {
    token_address: data.token_address,
    pair_address: data.pair_address,
    update_type: data.update_type,
    preliminary: !!data.preliminary,
    prediction: data.prediction,
    stored_at: Date.now(),
  };
  if (token) cache[token] = entry;
  if (pair && pair !== token) cache[`pair:${pair}`] = entry;
  const keys = Object.keys(cache);
  if (keys.length > 300) keys.slice(0, keys.length - 300).forEach((k) => delete cache[k]);

  if (kPredictionCacheWriteTimer) clearTimeout(kPredictionCacheWriteTimer);
  kPredictionCacheWriteTimer = setTimeout(() => {
    kPredictionCacheWriteTimer = null;
    const snapshot = { ...kPredictionCacheState };
    kPredictionCacheWriteInFlight = kPredictionCacheWriteInFlight
      .catch(() => {})
      .then(() => chrome.storage.local.set({ kPredictionCache: snapshot }));
  }, K_PREDICTION_CACHE_WRITE_DELAY_MS);
}

// ---------------------------------------------------------------- sound

// A service worker has no Audio API. Playing through a content script means
// obeying the axiom.trade page's autoplay policy, which keeps the context
// suspended until the user clicks inside that page — so an offscreen document
// is used instead. It also keeps alerting when the tab is backgrounded.
let offscreenReady = null;

async function ensureOffscreen() {
  if (!chrome.offscreen) return false;
  if (await chrome.offscreen.hasDocument()) return true;
  // Serialise: concurrent creates throw "Only a single offscreen document may
  // be created".
  if (!offscreenReady) {
    offscreenReady = chrome.offscreen
      .createDocument({
        url: "offscreen.html",
        reasons: ["AUDIO_PLAYBACK"],
        justification: "Play whitelist-match alert tones.",
      })
      .catch(() => {})
      .finally(() => { offscreenReady = null; });
  }
  await offscreenReady;
  return true;
}

// Fallback for the case the offscreen API is unavailable.
function playViaTabs(preset) {
  chrome.tabs.query({ url: ["https://*.axiom.trade/*"] }, (tabs) => {
    for (const tab of tabs) {
      if (!tab.id) continue;
      chrome.tabs.sendMessage(tab.id, { type: "PLAY_SOUND", preset }, () => {
        if (chrome.runtime.lastError) return;
      });
    }
  });
}

async function playSound(preset) {
  try {
    if (await ensureOffscreen()) {
      chrome.runtime.sendMessage({ target: "offscreen", type: "PLAY_SOUND", preset }, () => {
        if (chrome.runtime.lastError) return;
      });
      return;
    }
  } catch { /* fall through */ }
  playViaTabs(preset);
}

async function speakKPredictionRating(percent, tokenName = "") {
  try {
    if (!Number.isFinite(percent) || percent < 0 || percent > 100) return;
    if (!(await ensureOffscreen())) return;
    chrome.runtime.sendMessage({
      target: "offscreen",
      type: "SPEAK_K_PREDICTION_RATING",
      percent,
      tokenName: String(tokenName || "").replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, 80),
    }, () => {
      if (chrome.runtime.lastError) return;
    });
  } catch { /* voice notification must never affect trading */ }
}

function playMatchSound(matchType) {
  const cfg = soundSettings[matchType];
  if (!cfg || !cfg.enabled) return;
  playSound(cfg.name);
}

// Read-only hydration. Deliberately bypass the live-feed handlers and predictors.
async function fetchPulseReadyBatch(msg) {
  const valid = (values) => [...new Set((Array.isArray(values) ? values : [])
    .filter((v) => typeof v === "string" && /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(v)))];
  const tokens = valid(msg.tokenAddresses);
  const pairs = valid(msg.pairAddresses);
  if (!tokens.length && !pairs.length) return { success: false, error: "No addresses" };
  if (tokens.length + pairs.length > 100) return { success: false, error: "Batch too large" };
  const stored = await chrome.storage.local.get({ msfWsToken: "", msfServerUrl: "" });
  const base = BlackCarrotServer.normalize(stored.msfServerUrl);
  if (!base) return { success: false, error: "Server address required" };
  const key = String(stored.msfWsToken || "").trim();
  if (!key) return { success: false, error: "Access key required" };
  const response = await fetch(`${base}/ready/batch`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
    body: JSON.stringify({ token_addresses: tokens, pair_addresses: pairs }),
    signal: AbortSignal.timeout(8000),
  });
  if (!response.ok) return { success: false, error: `HTTP ${response.status}` };
  const body = await response.json();
  if (body?.success !== true || !Array.isArray(body?.data?.items)) {
    return { success: false, error: "Invalid batch response" };
  }
  const entries = body.data.items.map((entry) => {
    const payload = entry.payload || {};
    const dev = normalizeDevAddress(payload.deployer_address ?? payload.dev_address);
    const twitterMatch = matchTwitterWhitelist(payload);
    return { ...entry, meta: {
      dev_wl: !!dev && devWhitelist.has(dev),
      twitter_wl: twitterMatch.matched,
      twitter_wl_history_index: twitterMatch.historyIndex,
    } };
  });
  return { success: true, entries, missing: body.data.missing };
}


// ---------------------------------------------------------------- commands

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || typeof msg !== "object") return;

  if (msg.type === "K_PREDICTION_AUTO_BUY_EXECUTE") {
    const tokenAddress = String(msg.tokenAddress || "").trim();
    const senderUrl = sender?.url || sender?.tab?.url || "";
    const tabId = sender?.tab?.id;
    const point = msg.point || {};
    if (!/^https:\/\/([^.]+\.)?axiom\.trade\//.test(senderUrl) ||
        !/^[A-Za-z0-9]{32,44}$/.test(tokenAddress) ||
        !Number.isInteger(tabId) ||
        !Number.isFinite(point.x) || point.x < 0 || point.x > 10000 ||
        !Number.isFinite(point.y) || point.y < 0 || point.y > 10000) {
      sendResponse({ executed: false });
      return true;
    }
    (async () => {
      const allowed = await claimKPredictionAutoBuy(tokenAddress);
      if (!allowed) return { executed: false, reason: "already-claimed" };
      try {
        await dispatchNativeAxiomClick(tabId, point);
        return { executed: true };
      } catch (error) {
        await releaseKPredictionAutoBuyClaim(tokenAddress);
        return { executed: false, reason: String(error?.message || error) };
      }
    })()
      .then(sendResponse)
      .catch((error) => sendResponse({ executed: false, reason: String(error?.message || error) }));
    return true;
  }

  if (msg.type === "PULSE_READY_BATCH") {
    const senderUrl = sender?.url || sender?.tab?.url || "";
    if (!/^https:\/\/([^.]+\.)?axiom\.trade\//.test(senderUrl)) {
      sendResponse({ success: false, error: "Invalid sender" });
      return;
    }
    fetchPulseReadyBatch(msg).then(sendResponse).catch(() =>
      sendResponse({ success: false, error: "Batch request failed" }));
    return true;
  }

  if (msg.type === "WS_CACHE_QUERY") {
    const keys = Array.isArray(msg.keys) ? msg.keys : [];
    const result = {};
    for (const k of keys) {
      const kl = String(k || "").toLowerCase();
      if (!kl) continue;
      const e = wsMem.get(`pair:${kl}`) || wsMem.get(`token:${kl}`);
      if (e) result[kl] = e;
    }
    sendResponse({ entries: result });
    return true;
  }

  if (msg.type === "PLAY_SOUND_PREVIEW") {
    playSound(msg.preset);
    return;
  }

  if (msg.type === "SPEAK_K_PREDICTION_RATING") {
    speakKPredictionRating(Number(msg.percent), msg.tokenName);
    return;
  }

  if (msg.type === "WS_CONNECT") {
    shouldReconnect = true;
    reconnectAttempts = 0;
    if (reconnectTimer) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
    connectWs();
  } else if (msg.type === "WS_DISCONNECT") {
    disconnectWs();
  } else if (msg.type === "WS_STATUS_REQ") {
    const tabId = sender?.tab?.id;
    if (tabId) {
      chrome.tabs.sendMessage(
        tabId,
        { type: "WS_STATUS", status: lastStatus, error: lastError },
        () => {
          if (chrome.runtime.lastError) return;
        }
      );
    } else {
      chrome.runtime.sendMessage(
        { type: "WS_STATUS", status: lastStatus, error: lastError },
        () => {
          if (chrome.runtime.lastError) return;
        }
      );
    }
  }
});
