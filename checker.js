// Token checker. Mirrors the macOS app's Checker tab: paste a token address,
// pull its record, and put the dev or the twitter handle on a whitelist.
//
// Runs as both the side panel and a full tab — same page either way.



const addrEl = document.getElementById("addr");
const formEl = document.getElementById("lookupForm");
const checkEl = document.getElementById("check");
const msgEl = document.getElementById("msg");
const resultEl = document.getElementById("result");

let current = null; // last successful /ready response

// ---------------------------------------------------------------- helpers

function showMessage(text, isError) {
  msgEl.textContent = text;
  msgEl.classList.toggle("err", !!isError);
  msgEl.hidden = false;
}

function clearMessage() {
  msgEl.hidden = true;
}

function isEvmAddress(v) {
  return /^0x[0-9a-fA-F]{40}$/.test(String(v || ""));
}

// Must agree with background.js, or an entry added here would not match.
function normalizeDevAddress(v) {
  const s = String(v || "").trim();
  return isEvmAddress(s) ? s.toLowerCase() : s;
}

// An address may be pasted as a bare key or lifted out of a URL.
function extractAddress(raw) {
  const s = String(raw || "").trim();
  if (!s) return "";
  const m = s.match(/[1-9A-HJ-NP-Za-km-z]{32,44}/);
  return m ? m[0] : s;
}

function shorten(v, head = 6, tail = 6) {
  const s = String(v || "");
  return s.length > head + tail + 3 ? `${s.slice(0, head)}…${s.slice(-tail)}` : s;
}

function formatVolume(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return "—";
  const abs = Math.abs(n);
  const fmt = (x, suffix) => {
    const r = Math.round(x * 10) / 10;
    return `${r % 1 === 0 ? Math.trunc(r) : r}${suffix}`;
  };
  if (abs >= 1e9) return fmt(n / 1e9, "b");
  if (abs >= 1e6) return fmt(n / 1e6, "m");
  if (abs >= 1e3) return fmt(n / 1e3, "k");
  return String(Math.round(n));
}

// Same single-unit form the feed rows use.
function formatAge(dateString) {
  if (typeof dateString !== "string" || !dateString) return "-";
  const t = Date.parse(dateString);
  if (!Number.isFinite(t)) return "-";
  const s = Math.max(0, Math.floor((Date.now() - t) / 1000));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86400)}d`;
}

function el(tag, className, text) {
  const n = document.createElement(tag);
  if (className) n.className = className;
  if (text !== undefined) n.textContent = text;
  return n;
}

function metric(key, value, tone) {
  const m = el("span", "ck-metric");
  m.appendChild(el("span", "k", key));
  m.appendChild(el("span", "v" + (tone ? " " + tone : ""), value));
  return m;
}

function copyOnClick(node, value) {
  node.title = value;
  node.addEventListener("click", () => {
    navigator.clipboard.writeText(value).then(
      () => showMessage("Copied", false),
      () => {}
    );
  });
}

// ---------------------------------------------------------------- whitelists

async function getWhitelists() {
  const d = await chrome.storage.local.get({ devWhitelist: [], twitterWhitelist: [] });
  return {
    devWhitelist: Array.isArray(d.devWhitelist) ? d.devWhitelist : [],
    twitterWhitelist: Array.isArray(d.twitterWhitelist) ? d.twitterWhitelist : [],
  };
}

// Background reloads its cached lists from storage.onChanged, so a toggle here
// takes effect on the live feed without reconnecting.
async function toggleWhitelist(kind, rawValue) {
  const lists = await getWhitelists();
  const key = kind === "dev" ? "devWhitelist" : "twitterWhitelist";
  const value = kind === "dev" ? normalizeDevAddress(rawValue) : String(rawValue || "").trim();
  if (!value) return false;

  const list = lists[key];
  const idx = list.indexOf(value);
  if (idx >= 0) list.splice(idx, 1);
  else list.push(value);

  await chrome.storage.local.set({ [key]: list });
  return idx < 0; // true when it is now on the list
}

function wlButton(kind, rawValue, isOn) {
  const value = kind === "dev" ? normalizeDevAddress(rawValue) : String(rawValue || "").trim();
  const btn = el("button", "ck-wl" + (isOn ? " on" : ""));
  btn.type = "button";
  const label = () => (btn.classList.contains("on") ? "✓ in WL" : "+ WL");
  btn.textContent = label();
  if (!value) {
    btn.disabled = true;
    btn.textContent = "no data";
    return btn;
  }
  btn.title = value;
  btn.addEventListener("click", async () => {
    btn.disabled = true;
    const nowOn = await toggleWhitelist(kind, value);
    btn.classList.toggle("on", nowOn);
    btn.textContent = label();
    btn.disabled = false;
  });
  return btn;
}

// ---------------------------------------------------------------- fetching

async function fetchReady(tokenAddress) {
  const { msfWsToken, msfServerUrl } = await chrome.storage.local.get({ msfWsToken: "", msfServerUrl: "" });
  const api = BlackCarrotServer.normalize(msfServerUrl);
  if (!api) throw new Error("Set the server address and connect in the extension popup first.");
  const key = String(msfWsToken || "").trim();
  if (!key) {
    const e = new Error("No access key — set it in the extension popup first.");
    e.soft = true;
    throw e;
  }

  const res = await fetch(`${api}/ready/${encodeURIComponent(tokenAddress)}`, {
    headers: { Accept: "application/json", Authorization: `Bearer ${key}` },
  });

  if (res.status === 401) throw new Error("Access key rejected.");
  if (res.status === 404) throw new Error("No record for that token address.");
  if (!res.ok) throw new Error(`Request failed (HTTP ${res.status}).`);

  const body = await res.json();
  const payload = body?.data?.payload;
  if (!payload) throw new Error("Unexpected response shape.");
  return { payload, kPrediction: body.data.k_prediction };
}

// ---------------------------------------------------------------- rendering

function volumeBadgeSpecs(payload, settings) {
  if (!payload || typeof payload !== "object") return [];
  const badges = [];
  const color = (value, fallback) => /^#[0-9a-f]{6}$/i.test(String(value || "")) ? value : fallback;
  for (const [kind, label, volumeKey, thresholdKey, colorKey, fallback] of [
    ["dev", "★", "dev_volume_usd", "devVolBadgeThreshold", "devVolBadgeColor", "#22c55e"],
    ["twitter", "★", "all_twitter_volume_usd", "twitterVolBadgeThreshold", "twitterVolBadgeColor", "#3b82f6"],
  ]) {
    if (settings[kind === "dev" ? "showDevVolBadge" : "showTwitterVolBadge"] === false) continue;
    const value = payload[volumeKey];
    const volume = value == null || typeof value === "boolean" ? NaN : Number(value);
    const threshold = Number(settings[thresholdKey]);
    if (Number.isFinite(volume) && Number.isFinite(threshold) && threshold > 0 && volume >= threshold) {
      badges.push({ kind, label, color: color(settings[colorKey], fallback),
        title: `${kind === "dev" ? "Dev" : "Twitter"} volume ≥ $${threshold.toLocaleString("en-US")}` });
    }
  }
  if (settings.showTrustBadge !== false && payload.trust_qualified === true) {
    badges.push({ kind: "trust", label: "★", color: "#a855f7",
      title: "Trusted dev + Twitter pairs" });
  }
  return badges;
}

function renderTokenPanel(p, settings) {
  const panel = el("div", "ck-panel");
  const reuse = p.name_ticker_usage == null ? NaN : Number(p.name_ticker_usage);
  const positionRaw = p.twitter_publication_context?.token_number_in_publication;
  const position = positionRaw == null ? NaN : Number(positionRaw);
  const head = el("div", "ck-panel-head");
  const left = el("div");
  left.appendChild(el("div", "ck-token-name", p.token_name || "Unknown"));
  left.appendChild(el("div", "ck-token-ticker", p.token_ticker ? `$${p.token_ticker}` : ""));
  head.appendChild(left);
  const badges = volumeBadgeSpecs(p, settings);
  if (badges.length) {
    const group = el("div", "ck-volume-badges");
    for (const spec of badges) {
      const badge = el("span", "ck-combined-star", spec.label);
      badge.title = spec.title;
      badge.style.color = spec.color;
      badge.style.borderColor = spec.color;
      badge.style.backgroundColor = spec.color + "1f";
      group.appendChild(badge);
    }
    head.appendChild(group);
  }
  panel.appendChild(head);

  const addr = el("div", "ck-addr", p.token_address || "");
  if (p.token_address) copyOnClick(addr, p.token_address);
  panel.appendChild(addr);

  const metrics = el("div", "ck-metrics");
  metrics.appendChild(metric("reuse", Number.isFinite(reuse) ? String(reuse) : "—",
    Number.isFinite(reuse) && reuse <= settings.reuseThreshold ? "warn" : undefined));
  if (Number.isFinite(position)) {
    metrics.appendChild(metric("position", String(position),
      position <= settings.positionThreshold ? "warn" : undefined));
  }
  if (p.protocol) metrics.appendChild(metric("via", p.protocol));
  if (p.created_at) metrics.appendChild(metric("age", formatAge(p.created_at)));
  if (Number.isFinite(Number(p.global_fee))) {
    metrics.appendChild(metric("fee", Number(p.global_fee).toFixed(2)));
  }
  panel.appendChild(metrics);
  return panel;
}

function renderKPredictionPanel(prediction) {
  const probability = (prediction?.probability ?? prediction?.p_k_buy);
  if (typeof probability !== "number" || !Number.isFinite(probability) ||
      probability < 0 || probability > 1) return null;

  const panel = el("div", "ck-panel");
  const head = el("div", "ck-panel-head");
  head.appendChild(el("div", "ck-panel-label", "K prediction"));
  panel.appendChild(head);
  const metrics = el("div", "ck-metrics");
  const updateType = prediction.update_type || prediction.source || prediction.input_stage || "";
  const source = updateType === "sol_update_a" || (!updateType && prediction.rank === 1) ? "A" : "B";
  metrics.appendChild(metric(`K prediction ${source}`, `${(probability * 100).toFixed(2)}%`,
    prediction.selection_decision === "BUY_CANDIDATE" ? "good" : undefined));
  if (prediction.selection_decision) {
    metrics.appendChild(metric("decision", prediction.selection_decision));
  }
  if (typeof prediction.threshold === "number" && Number.isFinite(prediction.threshold)) {
    metrics.appendChild(metric("threshold", `${(prediction.threshold * 100).toFixed(2)}%`));
  }
  if (prediction.model_kind) metrics.appendChild(metric("model", prediction.model_kind));
  panel.appendChild(metrics);
  return panel;
}

function renderDevPanel(p, wl) {
  const panel = el("div", "ck-panel");
  const head = el("div", "ck-panel-head");
  head.appendChild(el("div", "ck-panel-label", "Dev"));
  head.appendChild(wlButton("dev", p.deployer_address, wl.dev));
  panel.appendChild(head);

  const addr = el("div", "ck-addr", p.deployer_address || "—");
  if (p.deployer_address) copyOnClick(addr, p.deployer_address);
  panel.appendChild(addr);

  const total = Number(p.total_tokens) || 0;
  const migrated = Number(p.migrated_tokens) || 0;
  const pct = Number(p.migrate_prc);

  const metrics = el("div", "ck-metrics");
  metrics.appendChild(metric("vol", `$${formatVolume(p.dev_volume_usd)}`));
  metrics.appendChild(metric("tokens", String(total)));
  metrics.appendChild(
    metric("migrated", `${migrated}${Number.isFinite(pct) ? ` · ${pct.toFixed(0)}%` : ""}`,
      pct >= 20 ? "good" : undefined)
  );
  // previous_tokens excludes the current one and runs newest-first.
  const prevAt = Array.isArray(p.previous_tokens) ? p.previous_tokens[0]?.createdAt : null;
  metrics.appendChild(metric("last launch", formatAge(prevAt)));
  panel.appendChild(metrics);

  return panel;
}

function renderTwitterPanel(p, wl) {
  const panel = el("div", "ck-panel");
  const head = el("div", "ck-panel-head");
  head.appendChild(el("div", "ck-panel-label", "Twitter"));
  head.appendChild(wlButton("twitter", p.twitter_handle, wl.twitter));
  panel.appendChild(head);

  if (p.twitter_handle) {
    const a = el("a", "ck-addr", `@${p.twitter_handle}`);
    a.href = `https://x.com/${p.twitter_handle}`;
    a.target = "_blank";
    a.rel = "noopener noreferrer";
    panel.appendChild(a);
  } else {
    panel.appendChild(el("div", "ck-empty", "no handle on this token"));
  }

  const metrics = el("div", "ck-metrics");
  metrics.appendChild(metric("vol", `$${formatVolume(p.all_twitter_volume_usd)}`));
  metrics.appendChild(metric("tokens", String(p.twitter_total_tokens ?? "—")));
  metrics.appendChild(metric("migrated", String(p.twitter_total_migrations ?? "—")));
  const ctx = p.twitter_publication_context || {};
  metrics.appendChild(metric("last post", formatAge(ctx.previous_publication_created_at)));
  panel.appendChild(metrics);

  const historyRaw = p.twitter_handle_history ?? p.twitterHandleHistory;
  const history = Array.isArray(historyRaw)
    ? historyRaw.filter((item) => item && typeof item === "object" && item.handle)
    : [];
  if (history.length) {
    const historyBlock = el("div", "ck-handle-history");
    historyBlock.appendChild(el("div", "ck-history-label", `Handle history (${history.length})`));
    for (const item of history) {
      const handle = String(item.handle || "").trim().replace(/^@/, "");
      if (!handle) continue;
      const row = el("div", "ck-history-row");
      const link = el("a", "ck-history-handle", `@${handle}`);
      link.href = `https://x.com/${encodeURIComponent(handle)}`;
      link.target = "_blank";
      link.rel = "noopener noreferrer";
      if (item.source) link.title = `Source: ${item.source}`;
      row.appendChild(link);
      row.appendChild(el("span", "ck-history-age", formatAge(item.createdAt ?? item.created_at)));
      historyBlock.appendChild(row);
    }
    panel.appendChild(historyBlock);
  }

  return panel;
}

function renderPreviousTokens(p) {
  const panel = el("div", "ck-panel");
  const list = Array.isArray(p.previous_tokens) ? p.previous_tokens : [];
  panel.appendChild(el("div", "ck-panel-label", `Previous tokens (${list.length})`));

  if (!list.length) {
    panel.appendChild(el("div", "ck-empty", "first launch from this dev"));
    return panel;
  }

  const table = el("div", "ck-table");
  for (const t of list.slice(0, 12)) {
    const row = el("div", "ck-row");
    row.appendChild(el("span", "name", t.tokenName || t.tokenTicker || shorten(t.tokenAddress)));
    const ath = Number(
      t.athMarketCap ??
      t.maxMarketCap ??
      t.max_market_cap ??
      t.ath_marketcap_usd ??
      t.ath
    );
    const athEl = el(
      "span",
      "ath",
      Number.isFinite(ath) && ath >= 0 ? `ATH $${formatVolume(ath)}` : "ATH —"
    );
    athEl.title = "All-time-high market cap";
    row.appendChild(athEl);
    const fee = Number(t.fee);
    const feeEl = el("span", "fee" + (fee >= 2 ? " hi" : ""),
      Number.isFinite(fee) ? fee.toFixed(2) : "—");
    row.appendChild(feeEl);
    row.appendChild(el("span", "mig " + (t.migrated ? "yes" : "no"), t.migrated ? "M" : "—"));
    row.appendChild(el("span", "ago", formatAge(t.createdAt)));
    table.appendChild(row);
  }
  panel.appendChild(table);
  return panel;
}

async function render(ready) {
  const p = ready.payload;
  const [lists, stored] = await Promise.all([
    getWhitelists(),
    chrome.storage.local.get({
      positionThreshold: 1,
      reuseThreshold: 1,
      combinedVolThreshold: 10000,
      showTrustBadge: true,
      showDevVolBadge: true,
      showTwitterVolBadge: true,
      devVolBadgeThreshold: 10000,
      devVolBadgeColor: "#22c55e",
      twitterVolBadgeThreshold: 10000,
      twitterVolBadgeColor: "#3b82f6",
    }),
  ]);
  const settings = { ...stored,
    devVolBadgeThreshold: stored.devVolBadgeThreshold ?? stored.combinedVolThreshold,
    twitterVolBadgeThreshold: stored.twitterVolBadgeThreshold ?? stored.combinedVolThreshold,
  };
  const wl = {
    dev: lists.devWhitelist.includes(normalizeDevAddress(p.deployer_address)),
    twitter: lists.twitterWhitelist.includes(String(p.twitter_handle || "").trim()),
  };

  const card = el("div", "ck-card");
  card.appendChild(renderTokenPanel(p, settings));
  const kPredictionPanel = renderKPredictionPanel(ready.kPrediction);
  if (kPredictionPanel) card.appendChild(kPredictionPanel);
  card.appendChild(renderDevPanel(p, wl));
  card.appendChild(renderTwitterPanel(p, wl));
  card.appendChild(renderPreviousTokens(p));

  resultEl.replaceChildren(card);
  resultEl.hidden = false;
}

// ---------------------------------------------------------------- actions

async function runCheck(rawAddress) {
  const address = extractAddress(rawAddress);
  if (!address) {
    showMessage("Enter a token address.", true);
    return;
  }
  addrEl.value = address;
  clearMessage();
  checkEl.disabled = true;
  checkEl.textContent = "…";
  try {
    current = await fetchReady(address);
    await render(current);
    clearMessage();
  } catch (err) {
    resultEl.hidden = true;
    showMessage(err.message || "Lookup failed.", !err.soft);
  } finally {
    checkEl.disabled = false;
    checkEl.textContent = "Check";
  }
}

// The axiom URL carries the PAIR address, and /ready only accepts the token
// address, so the pair has to be translated first — from the feed cache the
// background already keeps, or failing that from the page itself.
async function tokenAddressFromActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.url) return "";
  const m = tab.url.match(/axiom\.trade\/(?:meme|coin|pair)\/([A-Za-z0-9]{32,44})/);
  if (!m) return "";
  const pair = m[1];

  const cached = await new Promise((resolve) => {
    chrome.runtime.sendMessage({ type: "WS_CACHE_QUERY", keys: [pair] }, (res) => {
      if (chrome.runtime.lastError) return resolve(null);
      resolve(res?.entries?.[pair.toLowerCase()] || null);
    });
  });
  const fromCache = cached?.content?.token_address;
  if (fromCache) return fromCache;

  const fromPage = await new Promise((resolve) => {
    chrome.tabs.sendMessage(tab.id, { type: "GET_TOKEN_ADDRESS" }, (res) => {
      if (chrome.runtime.lastError) return resolve("");
      resolve(res?.tokenAddress || "");
    });
  });
  return fromPage;
}

formEl.addEventListener("submit", (e) => {
  e.preventDefault();
  runCheck(addrEl.value);
});

document.getElementById("openTab").addEventListener("click", (e) => {
  e.preventDefault();
  chrome.tabs.create({ url: chrome.runtime.getURL("checker.html") });
});

// Prefill from the open token page, but never over something already typed.
(async () => {
  if (addrEl.value.trim()) return;
  const address = await tokenAddressFromActiveTab();
  if (address) addrEl.value = address;
})();
