(() => {
  const SOURCE = "axiom-wl-ext";
  const TEST_MODE = false;
  const DEBUG_MESSAGES = false;
  const DEBUG_WL = false;
  const DEBUG_BADGE = false;
  let debugHandleCount = 0;
  let debugMessageCount = 0;

  const SELECTORS = {
    newPairsRow: "[data-token-address], [class*='group/pulseRow']",
  };

  const ATTRS = {
    tokenAddress: "data-token-address",
    pairAddress: "data-pair-address",
  };

  const flaggedPairs = new Map();
  const devByToken = new Map();
  const twitterByToken = new Map();
  const matchByToken = new Map();
  const matchByPair = new Map();
  const twitterWlHistoryIndexByToken = new Map();
  const twitterWlHistoryIndexByPair = new Map();
  const wlByToken = new Map();
  const reasonByToken = new Map();
const reasonByPair = new Map();
const labelByToken = new Map();
const twitterMonthlyByToken = new Map();
const twitterMonthlyByPair = new Map();
  const kPredictionByToken = new Map();
  const kPredictionByPair = new Map();
  const volumeByPair = new Map();
  const volumeByToken = new Map();
  const volumeByLabel = new Map();
  const pairByToken = new Map();
  const previewByPair = new Map();
  const recentTokens = new Map();
  let scanTimer = null;
  let positionThreshold = 1;
  let reuseThreshold = 1;
  let quickBuyFeesEnabled = true;
  let showDevVolume = true;
  let showDevPreviousLaunch = true;
  let showTwitterVolume = true;
  let showTwitterPreviousLaunch = true;
  let showUpdateBDelay = true;
  let feeHighlightThreshold = 0;
  let feeHighlightColor = "#f59e0b";
  let feeTokenCount = 3;
  let showTrustBadge = true;
  let showDevVolBadge = true;
  let showTwitterVolBadge = true;
  let devVolBadgeThreshold = 10000;
  let devVolBadgeColor = "#22c55e";
  let twitterVolBadgeThreshold = 10000;
  let twitterVolBadgeColor = "#3b82f6";
  const DEBUG_PREVIEW = false;
  const lastHoverLog = new Map();
  let hoverProbeTimer = null;
  let wsStatus = "disconnected";

  function normalizeTwitter(value) {
    if (!value) return "";
    let str = String(value).trim();
    if (!str) return "";
    const urlMatch = str.match(/(?:x\.com|twitter\.com)\/([^/?#]+)/i);
    if (urlMatch && urlMatch[1]) str = urlMatch[1];
    str = str.replace(/^@/, "");
    str = str.replace(/[^A-Za-z0-9_]+/g, "");
    return str.toLowerCase();
  }

  function normalizeDev(value) {
    if (!value) return "";
    return String(value).toLowerCase();
  }

  function normalizeTokenLabel(value) {
    if (!value) return "";
    return String(value).trim().replace(/\s+/g, " ").toLowerCase();
  }

  function extractTokenAddressFromRow(row) {
    if (!row) return "";
    // Axiom virtualises Pulse rows and reuses the same DOM element for another
    // token. Native attributes/links are authoritative; our cached attribute
    // may still describe the token that previously occupied this row.
    const native = row.getAttribute("data-tokenAddress");
    if (native && native.length >= 32) return native;
    const anchors = row.querySelectorAll("a[href]");
    for (const a of anchors) {
      const href = a.getAttribute("href") || "";
      let match = href.match(/pump\.fun\/coin\/([A-Za-z0-9]{32,44})/);
      if (match && match[1]) return match[1];
      match = href.match(/x\.com\/search\?q=([A-Za-z0-9]{32,44})/);
      if (match && match[1]) return match[1];
      match = href.match(/\/token\/([A-Za-z0-9]{32,44})/);
      if (match && match[1]) return match[1];
    }
    return row.getAttribute(ATTRS.tokenAddress) || "";
  }

  function extractPairAddressFromRow(row) {
    if (!row) return "";
    // As above, do not trust the extension attribute until current native DOM
    // and the token-to-pair mapping have been checked.
    const native = row.getAttribute("data-pairAddress");
    if (native && native.length >= 32) return native;
    const anchors = row.querySelectorAll("a[href]");
    for (const a of anchors) {
      const href = a.getAttribute("href") || "";
      let match = href.match(/pair_address=([A-Za-z0-9]{32,44})/i);
      if (match && match[1]) return match[1];
      match = href.match(/pairAddress=([A-Za-z0-9]{32,44})/i);
      if (match && match[1]) return match[1];
      match = href.match(/\/(?:meme|coin)\/([A-Za-z0-9]{32,44})/i);
      if (match && match[1]) return match[1];
      match = href.match(/\/pairs?\/([A-Za-z0-9]{32,44})/i);
      if (match && match[1]) return match[1];
      match = href.match(/\/pair\/([A-Za-z0-9]{32,44})/i);
      if (match && match[1]) return match[1];
    }
    const tokenAddress = getRowTokenAddress(row);
    if (tokenAddress) {
      const byToken = pairByToken.get(normalizeDev(tokenAddress));
      if (byToken) return byToken;
    }
    return row.getAttribute(ATTRS.pairAddress) || "";
  }

  function getRowTokenAddress(row) {
    const addr = extractTokenAddressFromRow(row);
    const previous = row.getAttribute(ATTRS.tokenAddress) || "";
    if (addr && previous !== addr) {
      row.setAttribute(ATTRS.tokenAddress, addr);
      // The pair cached beside the previous token is no longer safe. It will
      // be restored from current native DOM or pairByToken below.
      row.removeAttribute(ATTRS.pairAddress);
    }
    return addr;
  }

  function getRowPairAddress(row) {
    const addr = extractPairAddressFromRow(row);
    if (addr && row.getAttribute(ATTRS.pairAddress) !== addr) {
      row.setAttribute(ATTRS.pairAddress, addr);
    }
    return addr;
  }

  function extractPreviewText(raw, type) {
    if (!raw || typeof raw !== "object") return "";
    if (type === "tweet") {
      const tweet = raw.tweet || raw.data || raw;
      const tweetFields = [
        "full_text",
        "fullText",
        "text",
        "body",
        "content",
      ];
      for (const key of tweetFields) {
        const value = tweet[key];
        if (typeof value === "string" && value.trim()) return value.trim();
      }
    }
    const fields = [
      "full_text",
      "fullText",
      "text",
      "body",
      "description",
      "name",
      "title",
      "summary",
      "content",
    ];
    for (const key of fields) {
      const value = raw[key];
      if (typeof value === "string" && value.trim()) return value.trim();
    }
    return "";
  }

  function buildPreview(content) {
    if (!content || typeof content !== "object") return null;
    const type = content.type || "tweet";
    const data = content.data || {};
    const text = extractPreviewText(data, type);
    if (!text) return { type, text: "", raw: data };
    return { type, text, raw: data };
  }

  function getTokenAddressFromRowEl(rowEl) {
    if (!rowEl) return "";
    const attr = rowEl.getAttribute(ATTRS.tokenAddress);
    if (attr) return normalizeDev(attr);
    const link = rowEl.querySelector("a[href*='/coin/'], a[href*='/token/']");
    if (link) {
      const href = link.getAttribute("href") || "";
      const match = href.match(/\/(?:coin|token)\/([A-Za-z0-9]+)/);
      if (match && match[1]) return normalizeDev(match[1]);
    }
    return "";
  }

  function readVisibleTooltipText() {
    const candidates = findTooltipCandidates();
    for (const el of candidates) {
      const text = (el.textContent || "").trim();
      if (text && text.length > 3) return text;
    }
    return "";
  }

  function readCommunityTooltipText() {
    const nodes = queryAllDeep(
      "div.relative.mt-3.max-h-\\[92px\\].min-h-\\[28px\\] p.break-words"
    );
    for (const body of nodes) {
      const text = (body.textContent || "").trim();
      if (text && text.length > 3) return text;
    }
    return "";
  }

  function readTweetTooltipText() {
    const nodes = queryAllDeep(
      "span.text-\\[18px\\].text-wrap.break-words.break-all.text-white.w-full"
    );
    for (const body of nodes) {
      const text = (body.textContent || "").trim();
      if (text && text.length > 3) return text;
    }
    return "";
  }

  function readAccountTooltipText() {
    const nodes = queryAllDeep(
      "div.relative.mt-3.max-h-\\[92px\\].min-h-\\[28px\\] p.break-words.text-\\[15px\\].text-\\[\\#8B98A6\\]"
    );
    for (const body of nodes) {
      const text = (body.textContent || "").trim();
      if (text && text.length > 3) return text;
    }
    return "";
  }

  function extractTweetTextFromTooltip(rawText) {
    if (!rawText) return "";
    let text = String(rawText).replace(/\s+/g, " ").trim();
    if (!text) return "";
    text = text.replace(/Your browser does not support the video tag\./gi, "");
    text = text.replace(/Read more on X$/i, "");
    text = text.replace(
      /\d{1,2}:\d{2}\s?(AM|PM),\s?[A-Za-z]{3}\s?\d{1,2},\s?\d{4}.*$/i,
      ""
    );
    text = text.trim();
    const followersIdx = text.toLowerCase().lastIndexOf("followers");
    if (followersIdx !== -1) {
      text = text.slice(followersIdx + "followers".length).trim();
    }
    text = text.replace(/^RT@[^ ]+\s*/i, "").trim();
    return text;
  }

  function extractCommunityTextFromTooltip(rawText) {
    if (!rawText) return "";
    let text = String(rawText).replace(/\s+/g, " ").trim();
    if (!text) return "";
    const cutMarkers = [
      "Members",
      "Created by",
      "Created at",
      "Following",
      "Followers",
      "View community on X",
    ];
    let cutIdx = -1;
    for (const marker of cutMarkers) {
      const idx = text.indexOf(marker);
      if (idx !== -1) {
        cutIdx = cutIdx === -1 ? idx : Math.min(cutIdx, idx);
      }
    }
    if (cutIdx !== -1) {
      text = text.slice(0, cutIdx).trim();
    }
    return text;
  }

  function logHoverPreview(rowEl, iconType) {
    const tokenAddressKey = getTokenAddressFromRowEl(rowEl);
    if (!tokenAddressKey) return;
    const pairAddress = pairByToken.get(tokenAddressKey);
    if (!pairAddress) {
      if (DEBUG_PREVIEW) {
        console.log("[axiom-wl] hover preview missing pair", {
          icon: iconType,
          tokenAddress: tokenAddressKey,
        });
      }
      return;
    }
    const preview = previewByPair.get(normalizeDev(pairAddress));
    if (!preview || !preview.text) {
      if (DEBUG_PREVIEW) {
        console.log("[axiom-wl] hover preview missing text", {
          icon: iconType,
          pairAddress,
          hasPreview: !!preview,
        });
      }
      return;
    }
    const now = Date.now();
    const last = lastHoverLog.get(pairAddress) || 0;
    if (now - last < 800) return;
    lastHoverLog.set(pairAddress, now);
    if (DEBUG_PREVIEW) {
      console.log("[axiom-wl] hover preview", {
        icon: iconType,
        pairAddress,
        text: preview.text,
      });
    }
  }

  function logTooltipText(iconType) {
    if (!DEBUG_PREVIEW) return;
    const text =
      iconType === "tweet"
        ? readTweetTooltipText() || readVisibleTooltipText()
        : iconType === "community"
          ? readCommunityTooltipText() || readVisibleTooltipText()
          : iconType === "account"
            ? readAccountTooltipText() || readVisibleTooltipText()
            : readVisibleTooltipText();
    if (!text) return;
    let cleaned = text;
    if (iconType === "tweet") {
      cleaned = extractTweetTextFromTooltip(text);
    } else if (iconType === "community") {
      cleaned = extractCommunityTextFromTooltip(text);
    }
    console.log("[axiom-wl] hover tooltip", {
      icon: iconType,
      text: cleaned || text,
    });
  }

  function startTooltipProbe(iconType) {
    if (!DEBUG_PREVIEW) return;
    if (hoverProbeTimer) {
      clearTimeout(hoverProbeTimer);
      hoverProbeTimer = null;
    }
    const root = document.documentElement;
    const probe = new MutationObserver((mutations) => {
      for (const m of mutations) {
        for (const node of m.addedNodes) {
          if (!(node instanceof Element)) continue;
          const text = (node.textContent || "").trim();
          if (text.length > 3) {
            console.log("[axiom-wl] hover probe", {
              icon: iconType,
              text,
              tag: node.tagName,
              className: node.className || null,
            });
            probe.disconnect();
            return;
          }
        }
      }
    });
    probe.observe(root, { childList: true, subtree: true });
    hoverProbeTimer = setTimeout(() => {
      probe.disconnect();
      hoverProbeTimer = null;
    }, 800);
  }

  function updateWhitelist() {
    // deprecated: wl flags are now supplied by local WS payload
  }

  function getHandleFromPayload(payload) {
    return (
      payload.twitter_handle ??
      payload.twitterHandle ??
      payload.twitter ??
      payload.twitter_username ??
      null
    );
  }

  function getHandleFromRow(row) {
    if (!row || typeof row !== "object") return null;
    if (row.twitterHandle) return row.twitterHandle;
    if (row.twitter_handle) return row.twitter_handle;
    const raw = row.twitter || row.twitterUrl || row.twitter_url;
    if (!raw) return null;
    const str = String(raw);
    const match = str.match(/(?:x\.com|twitter\.com)\/([^/?#]+)/i);
    if (match && match[1]) return match[1];
    return null;
  }

  function getHandleFromArrayRow(row) {
    const handle = row[46];
    if (handle) return handle;
    const raw = row[10];
    if (!raw) return null;
    const str = String(raw);
    const match = str.match(/(?:x\.com|twitter\.com)\/([^/?#]+)/i);
    if (match && match[1]) return match[1];
    return null;
  }

  function matchTypeFromFlags(flags) {
    if (!flags) return null;
    const devMatch = !!flags.dev_wl;
    const twMatch = !!flags.twitter_wl;
    if (devMatch && twMatch) return "both";
    if (twMatch) return "tw";
    if (devMatch) return "dev";
    return null;
  }

  function badgeText(matchType, twitterHistoryIndex = 0) {
    if (matchType === "both") return "[o]";
    if (Number.isInteger(twitterHistoryIndex) && twitterHistoryIndex > 0) {
      return `[TWL${twitterHistoryIndex}]`;
    }
    if (matchType === "tw") return "[TWL]";
    if (matchType === "dev") return "[DWL]";
    return null;
  }

  function processRow(row) {
    if (!row || typeof row !== "object") return;
    let dev = null;
    let handle = null;
    let pairAddress = null;
    let tokenAddress = null;
    let tokenName = null;
    let tokenTicker = null;

    if (Array.isArray(row)) {
      pairAddress = row[0] ?? null;
      tokenAddress = row[1] ?? null;
      dev = normalizeDev(row[2]);
      tokenName = row[3] ?? null;
      tokenTicker = row[4] ?? null;
      handle = normalizeTwitter(getHandleFromArrayRow(row));
    } else {
      dev = normalizeDev(row.devAddress ?? row.dev_address);
      handle = normalizeTwitter(getHandleFromRow(row));
      pairAddress = row.pairAddress ?? row.pair_address;
      tokenAddress = row.tokenAddress ?? row.token_address;
      tokenName = row.tokenName ?? row.token_name;
      tokenTicker = row.tokenTicker ?? row.token_ticker;
    }
    if (TEST_MODE) {
      // no-op
    }

    const tokenNameKey = normalizeTokenLabel(tokenName);
    const tokenTickerKey = normalizeTokenLabel(tokenTicker);
    const tokenAddressKey = normalizeDev(tokenAddress);
    if (tokenAddressKey && dev) devByToken.set(tokenAddressKey, dev);
    if (tokenAddressKey && handle) twitterByToken.set(tokenAddressKey, handle);
    if (tokenAddressKey && pairAddress) pairByToken.set(tokenAddressKey, pairAddress);
    if (tokenAddressKey) {
      if (tokenNameKey) labelByToken.set(tokenAddressKey, tokenNameKey);
      else if (tokenTickerKey) labelByToken.set(tokenAddressKey, tokenTickerKey);
    }
    if (tokenNameKey) {
      recentTokens.set(tokenNameKey, Date.now());
    } else if (tokenTickerKey) {
      recentTokens.set(tokenTickerKey, Date.now());
    }
    if (DEBUG_WL && handle && debugHandleCount < 20) {
      debugHandleCount += 1;
      // no-op
    }
    scheduleScan();
  }

  function processNewPair(payload) {
    if (!payload || typeof payload !== "object") return;
    const pairAddress = payload.pair_address ?? payload.pairAddress;
    const tokenAddress = payload.token_address ?? payload.tokenAddress;
    const tokenName = payload.token_name ?? payload.tokenName;
    const tokenTicker = payload.token_ticker ?? payload.tokenTicker;

    const tokenNameKey = normalizeTokenLabel(tokenName);
    const tokenTickerKey = normalizeTokenLabel(tokenTicker);
    const tokenAddressKey = normalizeDev(tokenAddress);
    flaggedPairs.set(
      pairAddress ||
        tokenAddressKey ||
        `${tokenNameKey || ""}:${tokenTickerKey || ""}`,
      {
        pairAddress,
        tokenAddress,
        tokenName,
        tokenTicker,
      }
    );
    if (tokenNameKey) recentTokens.set(tokenNameKey, Date.now());
    else if (tokenTickerKey) recentTokens.set(tokenTickerKey, Date.now());
    if (tokenAddressKey)
      labelByToken.set(tokenAddressKey, tokenNameKey || tokenTickerKey);
    requestScan();
  }

  function tryParseMessage(data) {
    if (typeof data !== "string") return null;
    try {
      return JSON.parse(data);
    } catch {
      return null;
    }
  }

  function handleMessage(data) {
    const parsed = tryParseMessage(data);
    if (!parsed) return;
    if (parsed.type === "new_pairs" && parsed.content) {
      processNewPair(parsed.content);
      return;
    }
    if (Array.isArray(parsed) && parsed[0] === "new_pairs") {
      processNewPair(parsed[1]);
      return;
    }
  }

  function normalizeWsPayload(parsed) {
    if (!parsed || typeof parsed !== "object") return { type: null, content: null };
    if (Array.isArray(parsed) && parsed.length >= 2 && typeof parsed[0] === "string") {
      return { type: parsed[0], content: parsed[1] };
    }
    if (parsed.sol_update_a && typeof parsed.sol_update_a === "object") {
      return { type: "sol_update_a", content: parsed.sol_update_a };
    }
    if (parsed.sol_update_b && typeof parsed.sol_update_b === "object") {
      return { type: "sol_update_b", content: parsed.sol_update_b };
    }
    if (parsed.type && parsed.content) return { type: parsed.type, content: parsed.content };
    if (parsed.type && parsed.data) return { type: parsed.type, content: parsed.data };
    if (parsed.type) return { type: parsed.type, content: parsed };
    if (parsed.event && parsed.data) return { type: parsed.event, content: parsed.data };
    return { type: null, content: parsed };
  }

  function hookWebSocket() {
    const OriginalWebSocket = window.WebSocket;
    if (!OriginalWebSocket) return;

    function WrappedWebSocket(url, protocols) {
      const ws =
        protocols === undefined
          ? new OriginalWebSocket(url)
          : new OriginalWebSocket(url, protocols);
      ws.addEventListener("message", (event) => {
        handleMessage(event.data);
      });
      return ws;
    }

    WrappedWebSocket.prototype = OriginalWebSocket.prototype;
    Object.setPrototypeOf(WrappedWebSocket, OriginalWebSocket);
    window.WebSocket = WrappedWebSocket;
  }

  function handleWorkerMessage(data) {
    if (!data || typeof data !== "object") return;
    if (DEBUG_MESSAGES && debugMessageCount < 3) {
      debugMessageCount += 1;
    }
    if (data.type === "twitter-preview" && data.content) {
      const content = data.content;
      const pairAddress = normalizeDev(content.pairAddress || content.pair_address);
      const preview = buildPreview(content);
      if (pairAddress && preview) previewByPair.set(pairAddress, preview);
      if (DEBUG_PREVIEW) {
        console.log("[axiom-wl] twitter-preview", {
          pairAddress: content.pairAddress || content.pair_address || null,
          type: content.type || null,
          text: preview ? preview.text : null,
          rawKeys: content.data ? Object.keys(content.data) : null,
        });
      }
      return;
    }
    if (data.type === "REPLACE" && data.table === "newPairs") {
      if (Array.isArray(data.items)) {
        for (const item of data.items) processRow(item);
        requestScan();
      }
      return;
    }
    if (data.type === "DATA_OPERATIONS" && data.payload) {
      const payload = data.payload;
      if (payload.table === "newPairs" && Array.isArray(payload.operations)) {
        for (const op of payload.operations) {
          if (op && op.item) processRow(op.item);
        }
        requestScan();
      }
    }
  }

  function hookWorker() {
    const OriginalWorker = window.Worker;
    if (!OriginalWorker) return;

    function WrappedWorker(url, options) {
      const worker = new OriginalWorker(url, options);
      worker.addEventListener("message", (event) => {
        handleWorkerMessage(event.data);
      });
      return worker;
    }

    WrappedWorker.prototype = OriginalWorker.prototype;
    Object.setPrototypeOf(WrappedWorker, OriginalWorker);
    window.Worker = WrappedWorker;
  }

  let styleInjected = false;

  function ensureStyle() {
    if (styleInjected) return;
    if (document.getElementById("axiom-wl-style-v3")) {
      styleInjected = true;
      return;
    }
    const previous = document.getElementById("axiom-wl-style-v2");
    if (previous) previous.remove();
    const old = document.getElementById("axiom-wl-style");
    if (old) old.remove();
    const style = document.createElement("style");
    style.id = "axiom-wl-style-v3";
    style.textContent = `
      /* WL match badge */
      .axiom-wl-badge {
        display: inline-flex;
        align-items: center;
        margin-left: 4px;
        padding: 1px 5px;
        border-radius: 3px;
        font-size: 10px;
        line-height: 14px;
        font-weight: 700;
        letter-spacing: 0.02em;
        color: #22c55e;
        border: 1px solid rgba(34, 197, 94, 0.4);
        background: rgba(34, 197, 94, 0.07);
        white-space: nowrap;
        vertical-align: middle;
        flex: 0 0 auto;
      }
      /* Keep Axiom's token title on one line when our WL badge shares the row.
         Axiom no longer guarantees nowrap on the title itself. */
      .axiom-wl-name-row {
        flex-wrap: nowrap !important;
        min-width: 0;
      }
      .axiom-wl-token-name {
        min-width: 0;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap !important;
      }
      /* Base data label */
      .axiom-wl-vol {
        display: inline-flex;
        align-items: center;
        margin-left: 5px;
        font-size: 11px;
        line-height: 16px;
        font-weight: 600;
        white-space: nowrap;
        vertical-align: middle;
      }
      /* Left indicator bar (position+reuse) — sits above outline */
      .axiom-wl-lind {
        position: absolute;
        left: 0; top: 0; bottom: 0;
        width: 3px;
        pointer-events: none;
        z-index: 10;
        border-radius: 2px 0 0 2px;
      }
      /* Twitter volume */
      .axiom-wl-twitter-vol { color: inherit; }
      /* Time since the previous launch — metadata, kept quieter than the
         figures it follows so it does not compete with them. */
      .axiom-wl-tw-age,
      .axiom-wl-dev-age {
        color: #64748b;
        font-size: 11px;
        font-weight: 600;
        white-space: nowrap;
      }
      /* Twitter fees — slightly dimmer */
      /* Dev volume */
      .axiom-wl-dev-vol {
        color: rgb(200, 201, 209);
        font-size: 12px;
        font-weight: 500;
        font-family: Geist, "Geist Fallback", sans-serif;
        letter-spacing: normal;
        line-height: 18px;
        background: rgb(16, 17, 20);
        border: 0.5px solid rgba(34, 36, 45, 0.8);
        border-radius: 9999px;
        padding: 1px 6px;
      }
      /* Dev fees */
      .axiom-wl-dev-fees {
        color: rgb(200, 201, 209);
        font-size: 12px;
        font-weight: 500;
        font-family: Geist, "Geist Fallback", sans-serif;
        letter-spacing: normal;
        line-height: 18px;
        background: rgb(16, 17, 20);
        border: 0.5px solid rgba(34, 36, 45, 0.8);
        border-radius: 9999px;
        padding: 1px 6px;
      }
      .axiom-wl-dev-fees.axiom-wl-fee-hi {
        background: rgb(16, 17, 20);
        border-color: rgba(245,158,11,0.35);
      }
      .axiom-wl-combined-badge, .axiom-wl-volume-badge {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        flex: none;
        width: 18px;
        height: 18px;
        border-radius: 50%;
        font-size: 10px;
        font-weight: 800;
        line-height: 16px;
        border: 1px solid rgba(168,85,247,0.45);
        background: rgba(8,9,12,0.96);
        color: #a855f7;
        box-shadow: 0 1px 3px rgba(0,0,0,0.55);
        pointer-events: none;
      }
      .axiom-wl-volume-badges-image {
        position: absolute;
        top: 0;
        left: 50%;
        transform: translate(calc(-100% + 9px), -50%);
        z-index: 100;
        display: inline-flex;
        align-items: center;
        gap: 3px;
        pointer-events: none;
      }
      /* Dev extra container */
      .axiom-wl-dev-extra {
        display: inline-flex;
        align-items: center;
        gap: 4px;
        margin-left: 4px;
      }
      .axiom-wl-no-tooltip { pointer-events: auto; cursor: default; }
      /* Trigger reason — subtle amber */
      .axiom-wl-reason {
        display: inline-flex;
        align-items: center;
        margin-left: 4px;
        padding: 1px 7px;
        border-radius: 3px;
        font-size: 10px;
        line-height: 15px;
        font-weight: 500;
        color: #d97706;
        border: 1px solid rgba(217, 119, 6, 0.3);
        background: rgba(217, 119, 6, 0.05);
        white-space: nowrap;
        vertical-align: middle;
        max-width: 300px;
        overflow: hidden;
        text-overflow: ellipsis;
        pointer-events: none;
      }
      .axiom-wl-reason-row {
        display: flex;
        align-items: center;
        width: 100%;
        margin-bottom: 2px;
        pointer-events: none;
      }
      /* AB reuse/position counter */
      .axiom-wl-ab {
        color: #64748b;
        font-size: 10px;
        font-weight: 600;
        margin-left: 0;
        margin-right: 4px;
        vertical-align: middle;
      }
      .axiom-wl-ab span { color: inherit; }
      .axiom-wl-ab .axiom-wl-ab-hot { color: #f59e0b; }
      .axiom-quick-buy-fees {
        position: absolute;
        left: 9px;
        top: 7px;
        z-index: 2;
        display: flex;
        flex-direction: column;
        align-items: flex-start;
        gap: 2px;
        color: rgba(226, 232, 240, 0.92);
        font-size: 10px;
        line-height: 12px;
        font-weight: 700;
        font-variant-numeric: tabular-nums;
        text-shadow: 0 1px 2px rgba(0, 0, 0, 0.75);
        pointer-events: none;
      }
      .axiom-quick-buy-fee {
        padding: 0 3px;
        border-radius: 3px;
      }
      /* K prediction inherits the native address block layout and styling. */
      .axiom-wl-ai-pill { pointer-events: none; }
      .axiom-wl-ai-line {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        gap: 4px;
        white-space: nowrap;
      }
      .axiom-wl-ai-k-prediction { color: inherit; }
      .axiom-wl-ai-k-prediction[data-decision="BUY_CANDIDATE"] { color: #4ade80; }
      .axiom-wl-ai-k-prediction[data-decision="WATCH"] { color: #fbbf24; }
      .axiom-wl-b-latency {
        color: #64748b;
        font-variant-numeric: tabular-nums;
        white-space: nowrap;
      }
      /* K prediction selection — compact, fixed-size and confined to the metadata row. */
      .axiom-k-prediction-badge {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        flex: 0 0 auto;
        gap: 3px;
        height: 18px;
        padding: 0 5px;
        border: 1px solid rgba(100, 116, 139, 0.38);
        border-radius: 4px;
        background: rgba(15, 23, 42, 0.72);
        font-size: 11px;
        font-weight: 700;
        line-height: 16px;
        white-space: nowrap;
        pointer-events: none;
      }
      .axiom-k-prediction-badge[data-decision="BUY_CANDIDATE"] {
        color: #4ade80;
        border-color: rgba(74, 222, 128, 0.45);
        background: rgba(34, 197, 94, 0.10);
      }
      .axiom-k-prediction-badge[data-decision="WATCH"] {
        color: #fbbf24;
        border-color: rgba(251, 191, 36, 0.42);
        background: rgba(245, 158, 11, 0.09);
      }
      .axiom-k-prediction-badge[data-decision="SKIP"] {
        color: #94a3b8;
      }
      .axiom-k-prediction-letter { font-weight: 900; }
      .axiom-k-prediction-probability { color: inherit; font-variant-numeric: tabular-nums; }
      /* ---- Token page overlay (axiom-tp-*) ---- */
      /* Toolbar inline bar — normal flex child before the scrollable section */
      .axiom-tp-overlay {
        display: inline-flex;
        flex-shrink: 0;
        align-items: center;
        gap: 0;
        height: 100%;
        padding: 0;
        z-index: 20;
        font-family: inherit;
        pointer-events: auto;
        white-space: nowrap;
        border-left: 1px solid rgba(55,71,91,0.35);
      }
      .axiom-tp-content {
        display: inline-flex;
        flex-wrap: nowrap;
        align-items: center;
        gap: 6px;
        padding: 0 8px;
        overflow: hidden;
      }
      .axiom-tp-overlay.collapsed .axiom-tp-content {
        display: none;
      }
      .axiom-tp-toggle {
        display: flex;
        align-items: center;
        justify-content: center;
        flex-shrink: 0;
        width: 18px;
        height: 100%;
        cursor: pointer;
        background: none;
        border: none;
        color: #475569;
        font-size: 8px;
        font-family: inherit;
        padding: 0 3px;
        transition: color 0.15s;
        user-select: none;
      }
      .axiom-tp-toggle:hover { color: #94a3b8; }
      .axiom-tp-overlay.collapsed .axiom-tp-toggle { color: #64748b; }
      .axiom-tp-overlay .axiom-tp-group {
        display: inline-flex;
        align-items: center;
        gap: 6px;
        padding: 2px 8px;
        border-radius: 6px;
        background: rgba(125,211,252,0.06);
        border: 1px solid rgba(125,211,252,0.18);
      }
      .axiom-tp-overlay .axiom-tp-group-dev {
        background: rgba(226,232,240,0.05);
        border-color: rgba(226,232,240,0.16);
      }
      .axiom-tp-overlay .axiom-tp-tw-vol {
        color: #7dd3fc;
        font-size: 11px;
        font-weight: 800;
      }
      .axiom-tp-pill {
        display: inline-flex;
        align-items: center;
        gap: 3px;
        padding: 1px 5px;
        border-radius: 4px;
        border: 1px solid rgba(55, 71, 91, 0.65);
        background: rgba(10, 14, 22, 0.9);
        font-size: 11px;
        line-height: 14px;
        font-weight: 800;
        letter-spacing: -0.01em;
        white-space: nowrap;
      }
      .axiom-tp-pill .s { color: #4ade80; }
      .axiom-tp-pill .d { color: #334155; font-weight: 400; }
      .axiom-tp-pill .f { color: #7dd3fc; }
      .axiom-tp-pill .k { color: #94a3b8; }
      .axiom-tp-pill .k[data-decision="BUY_CANDIDATE"] { color: #4ade80; }
      .axiom-tp-pill .k[data-decision="WATCH"] { color: #fbbf24; }
      .axiom-tp-b-latency {
        display: inline-flex;
        align-items: center;
        padding: 1px 5px;
        border-radius: 4px;
        border: 1px solid rgba(100, 116, 139, 0.35);
        background: rgba(15, 23, 42, 0.58);
        color: #94a3b8;
        font-size: 11px;
        line-height: 14px;
        font-weight: 700;
        font-variant-numeric: tabular-nums;
        white-space: nowrap;
      }
      .axiom-tp-pill-overlay {
        position: absolute;
        top: 100%;
        left: 0;
        margin-top: 2px;
        z-index: 5;
        font-size: 12px;
        padding: 1px 5px;
      }
      .axiom-tp-ab {
        display: inline-flex;
        align-items: center;
        color: #64748b;
        font-size: 11px;
        font-weight: 700;
        margin-right: 0;
        padding: 1px 5px;
        border-radius: 4px;
        background: rgba(245, 158, 11, 0.10);
        border: 1px solid rgba(245, 158, 11, 0.30);
        flex-shrink: 0;
        white-space: nowrap;
        line-height: 1.2;
      }
      .axiom-tp-ab .sep { color: #475569; margin: 0 2px; }
      .axiom-tp-ab .hot { color: #f59e0b; }
      .axiom-tp-badge {
        display: inline-flex;
        align-items: center;
        margin-left: 0;
        padding: 1px 6px;
        border-radius: 4px;
        font-size: 11px;
        line-height: 14px;
        font-weight: 700;
        color: #22c55e;
        border: 1px solid rgba(34, 197, 94, 0.45);
        background: rgba(34, 197, 94, 0.10);
        white-space: nowrap;
        vertical-align: middle;
        flex-shrink: 0;
      }
      .axiom-tp-reason {
        display: inline-flex;
        align-items: center;
        margin-left: 0;
        padding: 1px 6px;
        border-radius: 4px;
        font-size: 11px;
        line-height: 14px;
        font-weight: 600;
        color: #f59e0b;
        border: 1px solid rgba(245, 158, 11, 0.45);
        background: rgba(245, 158, 11, 0.10);
        max-width: 360px;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
        vertical-align: middle;
        flex-shrink: 0;
      }
      /* Info-panel inserted rows (under DA: / CA:) */
      .axiom-tp-info-row {
        display: flex;
        align-items: center;
        gap: 8px;
        padding: 4px 12px 6px;
        flex-wrap: wrap;
      }
      .axiom-tp-info-row .axiom-tp-label {
        font-size: 11px;
        font-weight: 600;
        color: #64748b;
        letter-spacing: 0.02em;
        text-transform: uppercase;
      }
      .axiom-tp-dev-vol {
        display: inline-flex;
        align-items: center;
        font-size: 12px;
        font-weight: 800;
        letter-spacing: -0.02em;
        color: #f1f5f9;
        background: rgba(226,232,240,0.10);
        border: 1px solid rgba(226,232,240,0.20);
        border-radius: 6px;
        padding: 1px 7px;
        line-height: 1.3;
      }
      /* Time since the previous launch / post — metadata, quieter than the
         figures it follows. */
      .axiom-tp-age {
        display: inline-flex;
        align-items: center;
        font-size: 11px;
        font-weight: 700;
        color: #64748b;
        white-space: nowrap;
      }
      .axiom-tp-dev-fees {
        display: inline-flex;
        align-items: center;
        font-size: 10px;
        font-weight: 700;
        color: #e2e8f0;
        background: rgba(226,232,240,0.06);
        border: 1px solid rgba(226,232,240,0.14);
        border-radius: 4px;
        padding: 1px 5px;
      }
      .axiom-tp-tw-handle {
        display: inline-flex;
        align-items: center;
        font-size: 11px;
        font-weight: 800;
        letter-spacing: -0.01em;
        color: #7dd3fc;
        background: rgba(125,211,252,0.10);
        border: 1px solid rgba(125,211,252,0.22);
        border-radius: 6px;
        padding: 1px 7px;
        line-height: 1.3;
        text-decoration: none;
      }
      .axiom-tp-tw-handle:hover { background: rgba(125,211,252,0.18); }
    `;
    document.head.appendChild(style);
    styleInjected = true;
  }

  function rowKey(row) {
    const tokenAddress = row.getAttribute(ATTRS.tokenAddress);
    if (tokenAddress) return normalizeDev(tokenAddress);
    const nameEl = findNameAnchor(row);
    const nameText = nameEl?.textContent?.trim() || "";
    return normalizeTokenLabel(nameText);
  }

  function isFlagged(key, row) {
    const tokenAddress = row.getAttribute(ATTRS.tokenAddress);
    if (tokenAddress) {
      const addrKey = normalizeDev(tokenAddress);
      if (matchByToken.get(addrKey)) return true;
      const label = labelByToken.get(addrKey);
      if (label && matchByToken.get(label)) return true;
    }
    if (flaggedPairs.has(key)) return true;
    const nameEl = findNameAnchor(row);
    const nameText = normalizeTokenLabel(nameEl?.textContent);
    for (const entry of flaggedPairs.values()) {
      const entryName = normalizeTokenLabel(entry.tokenName);
      if (!entryName) continue;
      if (entryName === nameText) return true;
      if (
        entry.tokenTicker &&
        nameText &&
        nameText.includes(normalizeTokenLabel(entry.tokenTicker))
      )
        return true;
    }
    return false;
  }

  function getMatchTypeForRow(row, tokenLabel) {
    const pairAddress =
      row.getAttribute(ATTRS.pairAddress) || getRowPairAddress(row);
    if (pairAddress) {
      const pairKey = normalizeDev(pairAddress);
      const direct = matchByPair.get(pairKey);
      if (direct) return direct;
    }
    const tokenAddress =
      row.getAttribute(ATTRS.tokenAddress) || getRowTokenAddress(row);
    if (tokenAddress) {
      const addrKey = normalizeDev(tokenAddress);
      const direct = matchByToken.get(addrKey);
      if (direct) return direct;
      return null;
    }
    void tokenLabel;
    return null;
  }

  function getTwitterHistoryIndexForRow(row) {
    const pairAddress =
      row.getAttribute(ATTRS.pairAddress) || getRowPairAddress(row);
    if (pairAddress) {
      const index = twitterWlHistoryIndexByPair.get(normalizeDev(pairAddress));
      if (index) return index;
    }
    const tokenAddress =
      row.getAttribute(ATTRS.tokenAddress) || getRowTokenAddress(row);
    if (tokenAddress) {
      return twitterWlHistoryIndexByToken.get(normalizeDev(tokenAddress)) || 0;
    }
    return 0;
  }

  function updateMatchForToken(tokenAddressKey, context) {
    // deprecated: wl flags are now supplied by local WS payload
    void tokenAddressKey;
    void context;
  }

  function getHandleMatchFromRow(row, labelKey) {
    void row;
    void labelKey;
    return null;
  }

  function updateBadgeText(existingBadge, matchType, twitterHistoryIndex = 0) {
    if (!existingBadge || !matchType) return;
    const next = badgeText(matchType, twitterHistoryIndex);
    if (!next) return;
    if (existingBadge.textContent !== next) {
      existingBadge.textContent = next;
    }
  }

  function getTokenLabelsFromRow(row) {
    const nameEl = findNameAnchor(row);
    const nameText = normalizeTokenLabel(nameEl?.textContent);
    const tickerEl = row.querySelector("div.text-textPrimary.font-medium");
    const tickerText = normalizeTokenLabel(tickerEl?.textContent);
    return { nameText, tickerText };
  }

  function getTokenNameFromFiber(row) {
    const startEl = row.querySelector("i.icon-chef-hat, i[class*='icon-chef']") || row;
    const fk = Object.keys(startEl).find(k => k.startsWith("__reactFiber"));
    if (!fk) return null;
    let f = startEl[fk];
    for (let i = 0; i < 22 && f; i++) {
      const p = f.memoizedProps;
      if (p && typeof p === "object" && typeof p.tokenName === "string") return p.tokenName || null;
      f = f.return;
    }
    return null;
  }

  function findTwitterDisplayAnchor(row) {
    const anchors = row.querySelectorAll("a[href*='x.com/'],a[href*='twitter.com/']");
    for (const a of anchors) {
      const text = (a.textContent || "").trim();
      if (text.startsWith("@") || text.toLowerCase().startsWith("by @")) return a;
    }
    return null;
  }

  function hexToRgba(hex, alpha) {
    const h = hex.replace("#", "");
    const r = parseInt(h.slice(0, 2), 16);
    const g = parseInt(h.slice(2, 4), 16);
    const b = parseInt(h.slice(4, 6), 16);
    return `rgba(${r},${g},${b},${alpha})`;
  }

  function hexToRgbObj(hex) {
    const h = hex.replace("#", "");
    return {
      r: parseInt(h.slice(0, 2), 16),
      g: parseInt(h.slice(2, 4), 16),
      b: parseInt(h.slice(4, 6), 16),
    };
  }

  function rgbToCss(rgb, alpha) {
    return alpha === undefined
      ? `rgb(${rgb.r},${rgb.g},${rgb.b})`
      : `rgba(${rgb.r},${rgb.g},${rgb.b},${alpha})`;
  }

  function formatVolume(value) {
    if (value === null || value === undefined) return null;
    const num = Number(value);
    if (!Number.isFinite(num)) return null;
    const abs = Math.abs(num);
    const format = (n, suffix) => {
      const rounded = Math.round(n * 10) / 10;
      const str = rounded % 1 === 0 ? String(Math.trunc(rounded)) : String(rounded);
      return `${str}${suffix}`;
    };
    if (abs >= 1e9) return format(num / 1e9, "b");
    if (abs >= 1e6) return format(num / 1e6, "m");
    if (abs >= 1e3) return format(num / 1e3, "k");
    return String(Math.round(num));
  }

  // Elapsed time as a single unit: "45s", "13m", "2h", "4d". Same thresholds
  // the macOS app uses (formatTimeInterval). "-" when the field is missing or
  // unparseable — Date.parse handles both the ISO stamps on previous_tokens and
  // the Twitter-style "Wed Feb 18 04:50:46 +0000 2026" on publications.
  function formatAge(dateString) {
    // Strings only: Date.parse stringifies its argument, so a stray number like
    // 12345 would resolve to the year 12345 and quietly render "0s".
    if (typeof dateString !== "string" || !dateString) return "-";
    const t = Date.parse(dateString);
    if (!Number.isFinite(t)) return "-";
    const s = Math.max(0, Math.floor((Date.now() - t) / 1000));
    if (s < 60) return `${s}s`;
    if (s < 3600) return `${Math.floor(s / 60)}m`;
    if (s < 86400) return `${Math.floor(s / 3600)}h`;
    return `${Math.floor(s / 86400)}d`;
  }

  // previous_tokens excludes the current token and is ordered newest-first, so
  // [0] is the dev's preceding launch.
  function devPrevTokenAge(payload) {
    const prev = Array.isArray(payload?.previous_tokens) ? payload.previous_tokens[0] : null;
    return formatAge(prev?.createdAt);
  }

  // Time since the handle's previous publication. Not strictly the previous
  // token: when token_number_in_publication > 1 the account has already
  // launched on the current publication, so this reads older than the last
  // launch. The feed carries no per-token twitter timestamp to do better.
  function twitterPubAge(payload) {
    return formatAge(payload?.twitter_publication_context?.previous_publication_created_at);
  }

  function updateAgeBadge(row, target, className, text) {
    if (!row || !target) return null;
    ensureStyle();
    let el = row.querySelector(`.${className}`);
    if (!el) {
      el = document.createElement("span");
      el.className = `axiom-wl-vol ${className}`;
      target.insertAdjacentElement("afterend", el);
    }
    if (el.textContent !== text) el.textContent = text;
    return el;
  }

  function formatRatioPart(value) {
    if (value === null || value === undefined) return "0";
    const num = Number(value);
    if (!Number.isFinite(num)) return "0";
    if (Number.isInteger(num)) return String(num);
    const rounded = Math.round(num * 100) / 100;
    let str = String(rounded);
    if (str.includes(".")) str = str.replace(/\.?0+$/, "");
    return str;
  }

  function updateVolumeBadge(row, target, value, className) {
    if (!row || !target) return;
    const formatted = formatVolume(value);
    if (!formatted) return;
    ensureStyle();
    let badge = row.querySelector(`.${className}`);
    if (!badge) {
      badge = document.createElement("span");
      badge.className = `axiom-wl-vol ${className}`;
      target.insertAdjacentElement("afterend", badge);
    }
    const text = `$${formatted}`;
    if (badge.textContent !== text) badge.textContent = text;
    if (className === "axiom-wl-dev-vol") disableTooltipFor(badge);
  }

  function disableTooltipFor(el) {
    if (!el || el.dataset.axiomNoTooltip) return;
    el.dataset.axiomNoTooltip = "1";
    el.classList.add("axiom-wl-no-tooltip");
    el.removeAttribute("title");
    const stop = (e) => {
      e.stopPropagation();
      e.stopImmediatePropagation();
    };
    el.addEventListener("mouseenter", stop);
    el.addEventListener("mousemove", stop);
    el.addEventListener("mouseover", stop);
  }

  function getVolumePayloadForRow(row) {
    const tokenAddress = normalizeDev(row.getAttribute(ATTRS.tokenAddress));
    const pairAddress = normalizeDev(row.getAttribute("data-pair-address"));
    if (tokenAddress && volumeByToken.has(tokenAddress)) {
      return volumeByToken.get(tokenAddress);
    }
    if (pairAddress && volumeByPair.has(pairAddress)) {
      return volumeByPair.get(pairAddress);
    }
    if (tokenAddress || pairAddress) return null;
    const labels = getTokenLabelsFromRow(row);
    if (labels.nameText && volumeByLabel.has(labels.nameText)) {
      return volumeByLabel.get(labels.nameText);
    }
    if (labels.tickerText && volumeByLabel.has(labels.tickerText)) {
      return volumeByLabel.get(labels.tickerText);
    }
    return null;
  }

  function findTokenImageOuter(row) {
    if (!row) return null;
    // Pulse Display changes the token image from 63px (Bar) to 68px (Ring)
    // and adds several wrappers. Key off the actual token image instead of a
    // Tailwind size class so both layouts — and future sizes — keep working.
    const image = Array.from(row.querySelectorAll('img[class*="object-cover"]')).find((img) => {
      const width = Number(img.getAttribute("width")) || img.getBoundingClientRect().width;
      const height = Number(img.getAttribute("height")) || img.getBoundingClientRect().height;
      return width >= 40 && height >= 40;
    });
    return image?.closest('div[class~="group/image"]') ||
      row.querySelector('[class*="h-[63px]"][class*="w-[63px]"]') ||
      row.querySelector('[class*="h-[68px]"][class*="w-[68px]"]') ||
      null;
  }

  function findTokenImageColumn(row, imageOuter) {
    let node = imageOuter;
    while (node && node !== row) {
      if (node.querySelector('button[class*="group/copy"]')) return node;
      node = node.parentElement;
    }
    return imageOuter?.parentElement || null;
  }

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

  function currentVolumeBadgeSpecs(payload) {
    return volumeBadgeSpecs(payload, {showTrustBadge, showDevVolBadge, showTwitterVolBadge, devVolBadgeThreshold, devVolBadgeColor,
      twitterVolBadgeThreshold, twitterVolBadgeColor});
  }

  function updateImageVolumeBadges(row, payload) {
    row.querySelector(".axiom-wl-combined-badge-image")?.remove();
    let holder = row.querySelector(".axiom-wl-volume-badges-image");
    const specs = currentVolumeBadgeSpecs(payload);
    const host = findTokenImageOuter(row);
    if (!host || !specs.length) { holder?.remove(); return; }
    if (!holder) {
      holder = document.createElement("span");
      holder.className = "axiom-wl-volume-badges-image";
    }
    if (getComputedStyle(host).position === "static") host.style.position = "relative";
    if (holder.parentElement !== host) host.appendChild(holder);
    const signature = JSON.stringify(specs);
    if (holder.dataset.signature === signature) return;
    holder.dataset.signature = signature;
    holder.replaceChildren(...specs.map((spec) => {
      const badge = document.createElement("span");
      badge.className = `axiom-wl-volume-badge axiom-wl-${spec.kind}-badge`;
      badge.textContent = spec.label;
      badge.title = spec.title;
      badge.style.color = spec.color;
      badge.style.borderColor = hexToRgba(spec.color, 0.45);
      return badge;
    }));
  }

  function updateRowVolumes(row) {
    const oldFeeEl = row.querySelector(".axiom-wl-dev-fees");
    if (oldFeeEl) oldFeeEl.remove();
    const payload = getVolumePayloadForRow(row);
    if (!payload) { updateImageVolumeBadges(row, null); return; }

    const twitterAnchor = findTwitterDisplayAnchor(row);

    if (twitterAnchor) {
      if (showTwitterVolume) {
        updateVolumeBadge(
          row,
          twitterAnchor,
          payload.all_twitter_volume_usd,
          "axiom-wl-twitter-vol"
        );
      } else {
        row.querySelector(".axiom-wl-twitter-vol")?.remove();
      }
      // Sits after the volume when there is one; falls back to the handle so
      // the age still shows on rows with no twitter volume yet.
      const twVolEl = row.querySelector(".axiom-wl-twitter-vol");
      if (twVolEl && !twVolEl.dataset.axiomTwitterColor) {
        const twitterColor = getComputedStyle(twitterAnchor).color;
        twVolEl.style.color = twitterColor;
        twVolEl.dataset.axiomTwitterColor = twitterColor;
      }
      if (showTwitterPreviousLaunch) {
        updateAgeBadge(row, twVolEl || twitterAnchor, "axiom-wl-tw-age", twitterPubAge(payload));
      } else {
        row.querySelector(".axiom-wl-tw-age")?.remove();
      }
    }

    updateImageVolumeBadges(row, payload);
    const chefIcon = row.querySelector("i.icon-chef-hat");
    if (chefIcon) {
      const chip =
        chefIcon.closest("div.flex.h-\\[24px\\]") ||
        chefIcon.closest("div");
      const devRow = findDevRowContainer(chip, row) || chip?.parentElement || null;
      let devExtra = row.querySelector(".axiom-wl-dev-extra");
      if (!devExtra && devRow) {
        devExtra = document.createElement("div");
        devExtra.className = "axiom-wl-dev-extra";
        devRow.appendChild(devExtra);
      } else if (devExtra && devRow && devExtra.parentElement !== devRow) {
        devRow.appendChild(devExtra);
      }
      if (chip) {
        const formattedDev = formatVolume(payload.dev_volume_usd);
        if (showDevVolume && devExtra && formattedDev) {
          let devVolEl = devExtra.querySelector(".axiom-wl-dev-vol");
          if (!devVolEl) {
            devVolEl = document.createElement("span");
            devVolEl.className = "axiom-wl-vol axiom-wl-dev-vol";
            devExtra.appendChild(devVolEl);
          }
          const devText = `$${formattedDev}`;
          if (devVolEl.textContent !== devText) devVolEl.textContent = devText;
          disableTooltipFor(devVolEl);
        } else if (devExtra) {
          const devVolEl = devExtra.querySelector(".axiom-wl-dev-vol");
          if (devVolEl) devVolEl.remove();
        }
        if (showDevPreviousLaunch && devExtra) {
          // Between the volume and the fee list. Positioned explicitly rather
          // than by append order: the volume element comes and goes with the
          // data, so appending would leave the age in the wrong slot.
          let devAgeEl = devExtra.querySelector(".axiom-wl-dev-age");
          if (!devAgeEl) {
            devAgeEl = document.createElement("span");
            devAgeEl.className = "axiom-wl-vol axiom-wl-dev-age";
          }
          const afterEl = devExtra.querySelector(".axiom-wl-dev-vol");
          if (afterEl) {
            if (devAgeEl.previousElementSibling !== afterEl) {
              afterEl.insertAdjacentElement("afterend", devAgeEl);
            }
          } else if (devExtra.firstElementChild !== devAgeEl) {
            devExtra.insertBefore(devAgeEl, devExtra.firstElementChild);
          }
          const devAgeText = devPrevTokenAge(payload);
          if (devAgeEl.textContent !== devAgeText) devAgeEl.textContent = devAgeText;
          disableTooltipFor(devAgeEl);
        } else if (devExtra) {
          devExtra.querySelector(".axiom-wl-dev-age")?.remove();
        }
        if (devExtra && devExtra.childElementCount === 0) devExtra.remove();
      }
    }

    const tickerEl = row.querySelector(
      "div.text-textPrimary.font-medium"
    );
    if (tickerEl && payload.name_ticker_usage !== undefined) {
      const reuseValue = Number(payload.name_ticker_usage ?? 0);
      const positionValue = Number(
        payload.twitter_publication_context?.token_number_in_publication ?? 0
      );
      const reuseText = formatRatioPart(reuseValue);
      const positionText = formatRatioPart(positionValue);
      let abEl = row.querySelector(".axiom-wl-ab");
      if (!abEl) {
        abEl = document.createElement("span");
        abEl.className = "axiom-wl-vol axiom-wl-ab";
      }
      // Keep the reuse/publication counter in the ticker's own inline flow.
      // Axiom's title parent is no longer guaranteed to be a horizontal flex
      // row, so inserting this as a sibling can put it on a separate line and
      // push the ticker down.
      if (abEl.parentElement !== tickerEl || abEl !== tickerEl.firstChild) {
        tickerEl.insertBefore(abEl, tickerEl.firstChild);
      }
      let reuseEl = abEl.querySelector(".axiom-wl-ab-reuse");
      let posEl = abEl.querySelector(".axiom-wl-ab-pos");
      if (!reuseEl || !posEl) {
        abEl.textContent = "";
        reuseEl = document.createElement("span");
        reuseEl.className = "axiom-wl-ab-reuse";
        const sep = document.createTextNode("/");
        posEl = document.createElement("span");
        posEl.className = "axiom-wl-ab-pos";
        abEl.appendChild(reuseEl);
        abEl.appendChild(sep);
        abEl.appendChild(posEl);
      }
      if (reuseEl.textContent !== reuseText) reuseEl.textContent = reuseText;
      if (posEl.textContent !== positionText) posEl.textContent = positionText;
      const reuseHit = Number.isFinite(reuseValue) && reuseValue <= reuseThreshold;
      const posHit = Number.isFinite(positionValue) && positionValue <= positionThreshold;
      if (reuseHit) reuseEl.classList.add("axiom-wl-ab-hot");
      else reuseEl.classList.remove("axiom-wl-ab-hot");
      if (posHit) posEl.classList.add("axiom-wl-ab-hot");
      else posEl.classList.remove("axiom-wl-ab-hot");
      // Keep the threshold highlighting on the two values themselves, without
      // adding a colored strip to the left edge of the whole token card.
      setRowLeftIndicator(row, null);
    }

  }

  function setRowLeftIndicator(row, color) {
    let m = row.querySelector(".axiom-wl-lind");
    if (color) {
      if (!m) {
        // getComputedStyle forces a style flush, so only pay for it when the
        // indicator is actually being created.
        if (getComputedStyle(row).position === "static") row.style.position = "relative";
        m = document.createElement("div");
        m.className = "axiom-wl-lind";
        row.insertBefore(m, row.firstChild);
      }
      if (m.dataset.axiomLindColor !== color) {
        m.style.background = color;
        m.dataset.axiomLindColor = color;
      }
    } else {
      if (m) m.remove();
    }
  }

  function updateKPredictionOverlay(row) {
    const tokenAddr = normalizeDev(row.getAttribute(ATTRS.tokenAddress));
    const pairAddr = normalizeDev(row.getAttribute("data-pair-address"));
    const prediction =
      (tokenAddr && kPredictionByToken.get(tokenAddr)) ||
      (pairAddr && kPredictionByPair.get(pairAddr)) ||
      null;
    const volumePayload = getVolumePayloadForRow(row);
    const updateBDelay = showUpdateBDelay
      ? formatUpdateBDelay(volumePayload?.update_b_delay_seconds)
      : "";

    const oldLabel = row.querySelector(".axiom-wl-ai-label");
    if (oldLabel) oldLabel.remove();

    const imgOuter = findTokenImageOuter(row);
    if (!imgOuter) return;
    const col = findTokenImageColumn(row, imgOuter);
    if (!col) return;

    // Replace only the contract address. The native progress bar must remain
    // untouched so rows with and without a K prediction score have identical layout.
    // Axiom used to render the address as a direct <span>, but now wraps the
    // copy button in a <div>. Hide the whole direct child so it does not keep
    // taking up a row and push the address below the AI pill.
    const progressBar = col.querySelector('[class*="h-[2px]"]');
    const addrBlock = Array.from(col.children).find(
      (c) =>
        !c.classList.contains("axiom-wl-ai-pill") &&
        (c.tagName === "SPAN" || c.querySelector('button[class*="group/copy"]'))
    );

    let pill = col.querySelector(".axiom-wl-ai-pill");

    if (!prediction && !updateBDelay) {
      if (pill) pill.remove();
      if (progressBar) {
        progressBar.style.display = "";
        progressBar.removeAttribute("data-axiom-ai-hidden");
      }
      if (addrBlock) {
        addrBlock.style.display = "";
        addrBlock.removeAttribute("data-axiom-ai-hidden");
      }
      return;
    }

    ensureStyle();
    // Undo the behaviour of versions <= 0.2.6 without requiring a full page
    // refresh: older code may have hidden this row already.
    if (progressBar?.hasAttribute("data-axiom-ai-hidden")) {
      progressBar.style.display = "";
      progressBar.removeAttribute("data-axiom-ai-hidden");
    }
    if (addrBlock && !addrBlock.hasAttribute("data-axiom-ai-hidden")) {
      addrBlock.setAttribute("data-axiom-ai-hidden", "1");
      addrBlock.style.display = "none";
    }

    if (!pill) {
      pill = document.createElement(addrBlock?.tagName?.toLowerCase() || "div");
    }
    if (addrBlock) {
      pill.className = `${addrBlock.className} axiom-wl-ai-pill`.trim();
      if (pill.nextElementSibling !== addrBlock) {
        addrBlock.insertAdjacentElement("beforebegin", pill);
      }
    } else if (!pill.isConnected) {
      pill.className = "axiom-wl-ai-pill";
      imgOuter.insertAdjacentElement("afterend", pill);
    }

    let kPredictionHtml = "";
    let percentage = "";
    if (prediction) {
      const source = prediction.updateType === "sol_update_b" ? "B" : "A";
      const letter = prediction.decision === "BUY_CANDIDATE"
        ? "B"
        : prediction.decision === "WATCH"
          ? "W"
          : "S";
      percentage = `${(prediction.probability * 100).toFixed(2)}%`;
      kPredictionHtml = `<span class="axiom-wl-ai-k-prediction" data-decision="${prediction.decision}">${source} ${letter} ${percentage}</span>`;
    }
    const latencyHtml = updateBDelay
      ? `<span class="axiom-wl-b-latency">B ${updateBDelay}</span>`
      : "";
    const newHTML = `<span class="axiom-wl-ai-line">${kPredictionHtml}${latencyHtml}</span>`;
    if (pill.innerHTML !== newHTML) pill.innerHTML = newHTML;
    const titleParts = [];
    if (prediction) titleParts.push(`K prediction: ${prediction.decision} · rating=${percentage}`);
    if (updateBDelay) titleParts.push(`update_b received ${updateBDelay} after token launch`);
    pill.title = titleParts.join(" · ");
  }

  function formatUpdateBDelay(value) {
    const seconds = Number(value);
    if (!Number.isFinite(seconds) || seconds < 0) return "";
    return `${seconds.toFixed(3)}s`;
  }

  function updateQuickBuyFees(row) {
    if (!quickBuyFeesEnabled) {
      row.querySelectorAll(".axiom-quick-buy-fees").forEach((node) => node.remove());
      return;
    }
    const payload = getVolumePayloadForRow(row);
    const feeNums = Array.isArray(payload?.previous_tokens)
      ? payload.previous_tokens
          .slice(0, feeTokenCount)
          .map((token) => token?.fee == null ? null : Number(token.fee))
          .filter((fee) => Number.isFinite(fee))
      : [];
    const buttons = row.querySelectorAll("button[class*='group/quickBuyButton']");
    for (const button of buttons) {
      let list = button.querySelector(":scope > .axiom-quick-buy-fees");
      if (!feeNums.length) {
        if (list) list.remove();
        continue;
      }
      if (!list) {
        list = document.createElement("span");
        list.className = "axiom-quick-buy-fees";
        list.setAttribute("aria-hidden", "true");
        button.appendChild(list);
      }
      const key = `${feeNums.join("|")}|${feeHighlightThreshold}|${feeHighlightColor}`;
      if (list.dataset.feeKey === key) continue;
      list.textContent = "";
      for (const fee of feeNums) {
        const value = document.createElement("span");
        value.className = "axiom-quick-buy-fee";
        value.textContent = formatRatioPart(fee);
        if (feeHighlightThreshold > 0 && fee >= feeHighlightThreshold) {
          value.style.color = feeHighlightColor;
          value.style.background = hexToRgba(feeHighlightColor, 0.18);
        }
        list.appendChild(value);
      }
      list.dataset.feeKey = key;
    }
  }

  function ingestKPrediction(payload, origin = "live") {
    if (!payload || typeof payload !== "object") return;
    const tokenAddr = normalizeDev(payload.token_address ?? payload.tokenAddress);
    const pairAddr = normalizeDev(payload.pair_address ?? payload.pairAddress);
    const value = payload.prediction || payload;
    const decision = String(value.decision ?? value.selection_decision ?? "").toUpperCase();
    const probability = value.probability ?? value.p_k_buy;
    if (!tokenAddr && !pairAddr) return;
    if (!["BUY_CANDIDATE", "WATCH", "SKIP"].includes(decision)) return;
    if (typeof probability !== "number" || !Number.isFinite(probability) || probability < 0 || probability > 1) return;
    const updateType = String(payload.update_type || value.update_type || value.source || value.input_stage || (value.rank === 2 ? "sol_update_b" : value.rank === 1 ? "sol_update_a" : ""));
    const rank = updateType === "sol_update_b" ? 2 : 1;
    const originPriority = origin === "live" ? 3 : origin === "cache" ? 2 : 1;
    const current =
      (tokenAddr && kPredictionByToken.get(tokenAddr)) ||
      (pairAddr && kPredictionByPair.get(pairAddr)) ||
      null;
    // Pulse hydration, the local cache and live predictor results arrive over
    // independent async channels. Prefer B over A, and for the same update
    // type never let an older hydration result replace the live value that
    // just triggered speech/open/buy actions.
    if ((current?.rank || 0) > rank) return;
    if ((current?.rank || 0) === rank && (current?.originPriority || 0) > originPriority) return;
    const prediction = {
      decision,
      probability,
      updateType,
      rank,
      originPriority,
      updatedAt: Date.now(),
    };
    if (tokenAddr) kPredictionByToken.set(tokenAddr, prediction);
    if (pairAddr) kPredictionByPair.set(pairAddr, prediction);
  }

  function ingestVolumePayload(payload, source) {
    if (!payload || typeof payload !== "object") return;
    const pair = normalizeDev(payload.pair_address ?? payload.pairAddress);
    const token = normalizeDev(payload.token_address ?? payload.tokenAddress);
    const nameKey = normalizeTokenLabel(payload.token_name ?? payload.tokenName);
    const tickerKey = normalizeTokenLabel(payload.token_ticker ?? payload.tokenTicker);
    const base =
      (pair && volumeByPair.get(pair)) ||
      (token && volumeByToken.get(token)) ||
      (!pair && !token && nameKey && volumeByLabel.get(nameKey)) ||
      (!pair && !token && tickerKey && volumeByLabel.get(tickerKey)) ||
      null;
    let entry;
    if (source === "a") {
      entry = {
        ...(base || {}),
        dev_volume_usd: payload.dev_volume_usd ?? base?.dev_volume_usd,
        all_twitter_volume_usd: base?.trust_from_b ? base?.all_twitter_volume_usd : (payload.all_twitter_volume_usd ?? base?.all_twitter_volume_usd),
        previous_tokens: payload.previous_tokens ?? base?.previous_tokens,
        pair_address: payload.pair_address ?? payload.pairAddress ?? base?.pair_address,
        token_address: payload.token_address ?? payload.tokenAddress ?? base?.token_address,
        token_name: payload.token_name ?? payload.tokenName ?? base?.token_name,
        token_ticker: payload.token_ticker ?? payload.tokenTicker ?? base?.token_ticker,
        update_b_delay_seconds: payload.update_b_delay_seconds ?? base?.update_b_delay_seconds,
      };
    } else {
      entry = {
        ...(base || {}),
        dev_volume_usd: payload.dev_volume_usd ?? base?.dev_volume_usd,
        all_twitter_volume_usd: payload.all_twitter_volume_usd ?? base?.all_twitter_volume_usd,
        pair_address: payload.pair_address ?? payload.pairAddress ?? base?.pair_address,
        token_address: payload.token_address ?? payload.tokenAddress ?? base?.token_address,
        token_name: payload.token_name ?? payload.tokenName ?? base?.token_name,
        token_ticker: payload.token_ticker ?? payload.tokenTicker ?? base?.token_ticker,
        name_ticker_usage: payload.name_ticker_usage ?? base?.name_ticker_usage,
        twitter_publication_context: payload.twitter_publication_context ?? base?.twitter_publication_context,
        previous_tokens: payload.previous_tokens ?? base?.previous_tokens,
        migrate_prc: payload.migrate_prc ?? base?.migrate_prc,
        twitter_handle: payload.twitter_handle ?? payload.twitterHandle ?? base?.twitter_handle,
        update_b_delay_seconds: payload.update_b_delay_seconds ?? base?.update_b_delay_seconds,
      };
    }
    // Preserve explicit false and keep a late A from undoing B's trust status.
    if (typeof payload.trust_qualified === "boolean" && (source !== "a" || !base?.trust_from_b)) {
      entry.trust_qualified = payload.trust_qualified;
    }
    entry.trust_from_b = !!base?.trust_from_b || (source !== "a" && typeof payload.trust_qualified === "boolean");
    if (pair) volumeByPair.set(pair, entry);
    if (token) volumeByToken.set(token, entry);
    if (nameKey) volumeByLabel.set(nameKey, entry);
    if (tickerKey) volumeByLabel.set(tickerKey, entry);
  }

  function applyWlMeta(payload, meta) {
    if (!payload || typeof payload !== "object") return;
    const tokenAddress = payload.token_address ?? payload.tokenAddress;
    const pairAddress = payload.pair_address ?? payload.pairAddress;
    const tokenName = payload.token_name ?? payload.tokenName;
    const tokenTicker = payload.token_ticker ?? payload.tokenTicker;
    const twitterMonthly =
      payload.twitter_monthly_analytics ?? payload.twitterMonthlyAnalytics;
    const tokenAddressKey = normalizeDev(tokenAddress);
    const pairKey = normalizeDev(pairAddress);
    const tokenNameKey = normalizeTokenLabel(tokenName);
    const tokenTickerKey = normalizeTokenLabel(tokenTicker);
    const labelKey = tokenNameKey || tokenTickerKey;
    const devFlag =
      meta?.dev_wl ??
      meta?.devWl ??
      payload.dev_wl ??
      payload.devWl;
    const twitterFlag =
      meta?.twitter_wl ??
      meta?.twitterWl ??
      payload.twitter_wl ??
      payload.twitterWl;
    const twitterHistoryIndexRaw =
      meta?.twitter_wl_history_index ??
      meta?.twitterWlHistoryIndex ??
      payload.twitter_wl_history_index ??
      payload.twitterWlHistoryIndex ??
      0;
    const twitterHistoryIndex = Number.isInteger(Number(twitterHistoryIndexRaw))
      ? Math.max(0, Number(twitterHistoryIndexRaw))
      : 0;
    const matchType = matchTypeFromFlags({
      dev_wl: !!devFlag,
      twitter_wl: !!twitterFlag,
    });
    if (tokenAddressKey && pairAddress) {
      pairByToken.set(tokenAddressKey, pairAddress);
    }
    if (twitterMonthly) {
      if (tokenAddressKey) twitterMonthlyByToken.set(tokenAddressKey, twitterMonthly);
      if (pairKey) twitterMonthlyByPair.set(pairKey, twitterMonthly);
    }
    const flagKey =
      pairKey || tokenAddressKey || `${tokenNameKey || ""}:${tokenTickerKey || ""}`;
    if (matchType) {
      if (tokenAddressKey) matchByToken.set(tokenAddressKey, matchType);
      if (pairKey) matchByPair.set(pairKey, matchType);
      if (tokenAddressKey) {
        if (twitterHistoryIndex > 0) {
          twitterWlHistoryIndexByToken.set(tokenAddressKey, twitterHistoryIndex);
        } else {
          twitterWlHistoryIndexByToken.delete(tokenAddressKey);
        }
      }
      if (pairKey) {
        if (twitterHistoryIndex > 0) {
          twitterWlHistoryIndexByPair.set(pairKey, twitterHistoryIndex);
        } else {
          twitterWlHistoryIndexByPair.delete(pairKey);
        }
      }
      if (flagKey) {
        flaggedPairs.set(flagKey, {
          pairAddress,
          tokenAddress,
          tokenName,
          tokenTicker,
        });
      }
    } else if (flagKey) {
      if (tokenAddressKey) matchByToken.delete(tokenAddressKey);
      if (pairKey) matchByPair.delete(pairKey);
      if (tokenAddressKey) twitterWlHistoryIndexByToken.delete(tokenAddressKey);
      if (pairKey) twitterWlHistoryIndexByPair.delete(pairKey);
      flaggedPairs.delete(flagKey);
    }

    if (labelKey) recentTokens.set(labelKey, Date.now());
    const reasonRaw =
      meta?.trigger_reason ??
      meta?.triggerReason ??
      payload.trigger_reason ??
      payload.triggerReason;
    if (reasonRaw !== undefined && reasonRaw !== null) {
      const reason = String(reasonRaw).trim();
      if (reason) {
        if (tokenAddressKey) reasonByToken.set(tokenAddressKey, reason);
        if (pairKey) reasonByPair.set(pairKey, reason);
      }
    }
  }

  function findTwitterHandleInRow(row) {
    const anchors = row.querySelectorAll("a[href*='x.com/'],a[href*='twitter.com/']");
    for (const a of anchors) {
      const href = a.getAttribute("href") || "";
      const match = href.match(/(?:x\.com|twitter\.com)\/([^/?#]+)/i);
      if (match && match[1]) return normalizeTwitter(match[1]);
    }
    const text = row.textContent || "";
    const matchText = text.match(/@([A-Za-z0-9_]{1,15})/);
    if (matchText && matchText[1]) return normalizeTwitter(matchText[1]);
    return null;
  }

  function findNameAnchor(row) {
    const nameRow = row.querySelector(
      "div.flex.flex-row.items-center.justify-start.gap-\\[4px\\]"
    );
    if (nameRow) {
      const withCopy = nameRow.querySelector(
        "span.flex.min-w-0.cursor-pointer.flex-row.items-center.justify-start.gap-\\[4px\\]"
      );
      if (withCopy) return withCopy;
      const primary = nameRow.querySelector("div.text-textPrimary.font-medium");
      if (primary) return primary;
      return nameRow;
    }
    return row.querySelector("div.text-textPrimary.font-medium");
  }

  function addBadgeAfter(node, label, tokenKey, badgeText) {
    if (!node) return;
    if (tokenKey) {
      if (
        document.querySelector(
          `.axiom-wl-badge[data-wl-token="${CSS.escape(tokenKey)}"]`
        )
      )
        return;
    } else if (node.parentElement?.querySelector(".axiom-wl-badge")) {
      return;
    }
    if (node.parentElement) {
      node.parentElement.classList.add("axiom-wl-name-row");
      node.parentElement.style.flexWrap = "nowrap";
      node.parentElement.style.alignItems = "center";
      node.parentElement.style.gap = "4px";
    }
    node.classList.add("axiom-wl-token-name");
    ensureStyle();
    const badge = document.createElement("span");
    badge.className = "axiom-wl-badge";
    badge.textContent = badgeText || (TEST_MODE ? "[wl]" : "[o]");
    if (node.tagName === "SPAN" && node.querySelector("i.ri-file-copy-line")) {
      const icon = node.querySelector("i.ri-file-copy-line");
      icon.insertAdjacentElement("afterend", badge);
    } else {
      node.insertAdjacentElement("afterend", badge);
    }
    if (tokenKey) badge.setAttribute("data-wl-token", tokenKey);
    if (TEST_MODE) {
      console.log("[axiom-wl] badge added", label || node.textContent?.trim());
    }
  }

  function addBadge(row) {
    const existing = row.querySelector(".axiom-wl-badge");
    const nameEl = findNameAnchor(row);
    if (!nameEl) {
      if (DEBUG_BADGE) {
        // no-op
      }
      return;
    }
    const tokenAddress = row.getAttribute(ATTRS.tokenAddress) || "";
    const tokenLabelRaw = nameEl.textContent?.trim() || tokenAddress;
    if (!tokenLabelRaw) {
      if (DEBUG_BADGE) {
        // no-op
      }
      return;
    }
    const labelKey =
      normalizeTokenLabel(tokenLabelRaw) || normalizeDev(tokenAddress);
    const uniqueKey = tokenAddress
      ? `${labelKey}|${normalizeDev(tokenAddress)}`
      : labelKey;
    let matchType = getMatchTypeForRow(row, labelKey);
    const twitterHistoryIndex = getTwitterHistoryIndexForRow(row);
    if (!matchType) {
      matchType = getHandleMatchFromRow(row, labelKey);
    }
    if (existing) {
      updateBadgeText(existing, matchType, twitterHistoryIndex);
      return;
    }
    // Bail on the no-match case before the document-wide lookup below: most rows
    // never get a badge, and this runs for each of them on every scan.
    if (!TEST_MODE && !matchType) {
      if (DEBUG_BADGE) {
        // no-op
      }
      return;
    }
    if (
      document.querySelector(
        `.axiom-wl-badge[data-wl-token="${CSS.escape(uniqueKey)}"]`
      )
    ) {
      if (DEBUG_BADGE) {
        // no-op
      }
      return;
    }
    addBadgeAfter(
      nameEl,
      tokenLabelRaw,
      uniqueKey,
      badgeText(matchType, twitterHistoryIndex)
    );
  }

  // Trigger-reason labels (e.g. "Dev+Twitter WL") are disabled: they caused
  // layout shifting above the token name. Nothing creates them anymore, so a
  // single sweep at startup is enough to clear any left over in a live page.
  function cleanupTriggerReasonBadges() {
    for (const el of document.querySelectorAll(
      ".axiom-wl-reason, .axiom-wl-reason-row"
    )) {
      el.remove();
    }
  }

  function findDevRowContainer(chip, row) {
    let node = chip?.parentElement || null;
    while (node && node !== row) {
      const cls = typeof node.className === "string" ? node.className : "";
      if (
        cls.includes("h-[24px]") &&
        cls.includes("w-full") &&
        cls.includes("flex-row")
      ) {
        return node;
      }
      node = node.parentElement;
    }
    return null;
  }

  // Walking every element to discover shadow roots is the single most expensive
  // thing this script does, so the result is cached — shadow roots are attached
  // rarely, and a stale entry only costs one extra scan cycle.
  const ROOTS_TTL_MS = 1000;
  let rootsCache = null;
  let rootsCacheAt = 0;

  function collectRoots() {
    const now = Date.now();
    if (rootsCache && now - rootsCacheAt < ROOTS_TTL_MS) return rootsCache;
    const roots = [document];
    const queue = [document];
    while (queue.length) {
      const root = queue.shift();
      const tree =
        root instanceof ShadowRoot || root instanceof Document
          ? root
          : root.shadowRoot;
      if (!tree) continue;
      const walker = tree.querySelectorAll("*");
      for (const el of walker) {
        if (el.shadowRoot) {
          roots.push(el.shadowRoot);
          queue.push(el.shadowRoot);
        }
      }
    }
    rootsCache = roots;
    rootsCacheAt = now;
    return roots;
  }

  function queryAllDeep(selector) {
    const roots = collectRoots();
    if (roots.length === 1) return Array.from(roots[0].querySelectorAll(selector));
    const results = [];
    for (const root of roots) {
      for (const el of root.querySelectorAll(selector)) results.push(el);
    }
    return results;
  }


  const NEW_PAIRS_PROBE_MS = 500;
  let newPairsContainer = null;
  let newPairsProbeAt = 0;

  function getNewPairsContainer() {
    if (newPairsContainer && newPairsContainer.isConnected) return newPairsContainer;
    const now = Date.now();
    // Only re-probe on a cooldown while the container is missing; once found it
    // is revalidated for free via isConnected above.
    if (!newPairsContainer && now - newPairsProbeAt < NEW_PAIRS_PROBE_MS) return null;
    newPairsProbeAt = now;
    newPairsContainer = null;
    let heading = null;
    for (const root of collectRoots()) {
      for (const el of root.querySelectorAll("span")) {
        if (el.textContent && el.textContent.trim() === "New Pairs") {
          heading = el;
          break;
        }
      }
      if (heading) break;
    }
    if (!heading) return null;
    let node = heading.parentElement;
    while (node && node !== document.body) {
      if (node.querySelector(SELECTORS.newPairsRow)) {
        newPairsContainer = node;
        return node;
      }
      node = node.parentElement;
    }
    return null;
  }

  // ---------- Token page overlay ----------


  let _tpCollapsed = false;

  function isTokenPage() {
    return /^\/(meme|coin|pair)\//.test(location.pathname);
  }

  function getTokenPageAddresses() {
    const parts = location.pathname.split("/");
    const fromUrl = parts[2] || "";
    let pairAddress = "";
    if (/^[A-Za-z0-9]{32,44}$/.test(fromUrl)) {
      pairAddress = fromUrl;
    }
    const pairKey = normalizeDev(pairAddress);

    // pairKey is always authoritative from URL; no need to cache it
    // tokenKey (token_address) is stable across migrations — read fresh each time
    // so stale DOM self-heals within 1-2 rAF frames without risking wrong cache
    let tokenKey = "";
    const pumpLink = document.querySelector("a[href*='pump.fun/coin/']");
    if (pumpLink) {
      const m = pumpLink.getAttribute("href").match(/pump\.fun\/coin\/([A-Za-z0-9]{32,44})/);
      if (m) tokenKey = normalizeDev(m[1]);
    }
    if (!tokenKey && pairKey) {
      for (const [token, pair] of pairByToken) {
        if (normalizeDev(pair) === pairKey) {
          tokenKey = token;
          break;
        }
      }
    }
    return { pairKey, tokenKey };
  }

  // The favourites strip the token-page overlay attaches to. Axiom dropped the
  // `grayscale` class this used to key on — the row now carries opacity-[0.85]
  // instead — so match on structure rather than on styling classes, which churn.
  function findToolbarRow() {
    // The strip's own section is tagged group/ticker, the one durable handle here.
    const ticker = document.querySelector("section[class*='group/ticker']");
    if (ticker) return ticker.closest("div[class*='h-[28px]']") || ticker.parentElement;
    // Otherwise any 28px row that holds the flex-1 section we insert into.
    for (const row of document.querySelectorAll("div[class*='h-[28px]']")) {
      if (row.querySelector("section[class*='flex-1']")) return row;
    }
    // Pre-redesign builds.
    return document.querySelector("div[class*='h-[28px]'][class*='grayscale']");
  }

  function scanTokenPage() {
    if (!isTokenPage()) {
      removeTokenPageOverlay();
      return;
    }
    const { tokenKey, pairKey } = getTokenPageAddresses();
    const toolbarRow = findToolbarRow();
    if (!tokenKey && !pairKey) {
      removeTokenPageOverlay();
      return;
    }
    if (!toolbarRow) return;
    const prediction =
      (tokenKey && kPredictionByToken.get(tokenKey)) ||
      (pairKey && kPredictionByPair.get(pairKey)) ||
      null;
    const matchType =
      (tokenKey && matchByToken.get(tokenKey)) ||
      (pairKey && matchByPair.get(pairKey)) ||
      null;
    const twitterHistoryIndex =
      (tokenKey && twitterWlHistoryIndexByToken.get(tokenKey)) ||
      (pairKey && twitterWlHistoryIndexByPair.get(pairKey)) ||
      0;
    const reason =
      (tokenKey && reasonByToken.get(tokenKey)) ||
      (pairKey && reasonByPair.get(pairKey)) ||
      "";
    const payload =
      (tokenKey && volumeByToken.get(tokenKey)) ||
      (pairKey && volumeByPair.get(pairKey)) ||
      null;
    const analytics =
      (tokenKey && twitterMonthlyByToken.get(tokenKey)) ||
      (pairKey && twitterMonthlyByPair.get(pairKey)) ||
      null;

    ensureStyle();
    renderTokenPageOverlay(toolbarRow, {
      prediction,
      matchType,
      twitterHistoryIndex,
      reason,
      payload,
      analytics,
    });
  }

  function removeTokenPageOverlay() {
    const o = document.getElementById("axiom-tp-overlay");
    if (o) o.remove();
  }

  function renderTokenPageOverlay(toolbarRow, ctx) {
    const {
      prediction,
      matchType,
      twitterHistoryIndex,
      reason,
      payload,
      analytics,
    } = ctx;
    const hasAnything =
      prediction || matchType || reason || payload || (analytics && analytics.months);
    if (!hasAnything) {
      removeTokenPageOverlay();
      return;
    }

    const badgeStr = badgeText(matchType, twitterHistoryIndex);

    // Ratio (reuse/position)
    const reuseValue =
      payload && payload.name_ticker_usage !== undefined
        ? Number(payload.name_ticker_usage ?? 0)
        : null;
    const positionValue =
      payload &&
      payload.twitter_publication_context &&
      payload.twitter_publication_context.token_number_in_publication !== undefined
        ? Number(payload.twitter_publication_context.token_number_in_publication ?? 0)
        : null;

    // Dev
    const devVolFormatted = showDevVolume && payload ? formatVolume(payload.dev_volume_usd) : null;
    const prevTokens = Array.isArray(payload?.previous_tokens)
      ? payload.previous_tokens.slice(0, feeTokenCount)
      : [];
    const devFees = prevTokens
      .map((t) => (t && t.fee !== undefined && t.fee !== null ? Number(t.fee) : null))
      .filter((v) => v !== null && Number.isFinite(v));

    // Twitter
    const twVolFormatted = showTwitterVolume && payload ? formatVolume(payload.all_twitter_volume_usd) : null;
    const twHandle = payload?.twitter_handle || payload?.twitterHandle || "";
    const updateBDelay = showUpdateBDelay ? formatUpdateBDelay(payload?.update_b_delay_seconds) : "";

    // Time since the dev's previous launch and since the handle's previous
    // post. Deliberately kept out of `sig` below: they tick every second, and
    // rebuilding the whole bar for that would thrash the DOM and drop the
    // toggle's listener. They are patched in by text instead.
    const devAgeText = devPrevTokenAge(payload);
    const twAgeText = twitterPubAge(payload);

    const volumeBadges = currentVolumeBadgeSpecs(payload);

    const sig = JSON.stringify({
      kp: prediction ? [prediction.updateType, prediction.decision, prediction.probability] : null,
      m: badgeStr,
      r: reason,
      ru: reuseValue,
      po: positionValue,
      rt: reuseThreshold,
      pt: positionThreshold,
      dv: devVolFormatted,
      df: devFees,
      ft: feeTokenCount,
      fh: feeHighlightThreshold,
      fc: feeHighlightColor,
      tv: twVolFormatted,
      th: twHandle,
      sdv: showDevVolume,
      sda: showDevPreviousLaunch,
      stv: showTwitterVolume,
      sta: showTwitterPreviousLaunch,
      sbd: showUpdateBDelay,
      vb: volumeBadges,
      bd: updateBDelay,
    });

    let root = document.getElementById("axiom-tp-overlay");
    const toolbarSection = toolbarRow.querySelector("section[class*='flex-1']");
    const insertTarget = toolbarSection || toolbarRow;
    if (!root) {
      root = document.createElement("div");
      root.id = "axiom-tp-overlay";
      root.className = "axiom-tp-overlay";
      insertTarget.appendChild(root);
    } else if (root.parentElement !== insertTarget) {
      insertTarget.appendChild(root);
    }
    if (_tpCollapsed) root.classList.add("collapsed");
    else root.classList.remove("collapsed");

    const applyAges = () => {
      const d = root.querySelector(".axiom-tp-dev-age");
      if (d && d.textContent !== devAgeText) d.textContent = devAgeText;
      const t = root.querySelector(".axiom-tp-tw-age");
      if (t && t.textContent !== twAgeText) t.textContent = twAgeText;
    };

    if (root.dataset.sig === sig) {
      applyAges();
      return;
    }
    root.dataset.sig = sig;

    const parts = [];
    if (prediction) {
      const source = prediction.updateType === "sol_update_b" ? "B" : "A";
      const letter = prediction.decision === "BUY_CANDIDATE" ? "B" : prediction.decision === "WATCH" ? "W" : "S";
      const percentage = `${(prediction.probability * 100).toFixed(2)}%`;
      parts.push(
        `<span class="axiom-tp-pill"><span class="k" data-decision="${prediction.decision}">${source} ${letter} ${percentage}</span></span>`
      );
    }
    if (updateBDelay) {
      parts.push(`<span class="axiom-tp-b-latency" title="Time from token launch to update_b">B ${updateBDelay}</span>`);
    }
    if (reuseValue !== null && positionValue !== null) {
      const reuseHot = Number.isFinite(reuseValue) && reuseValue <= reuseThreshold;
      const posHot = Number.isFinite(positionValue) && positionValue <= positionThreshold;
      parts.push(
        `<span class="axiom-tp-ab"><span class="${reuseHot ? "hot" : ""}">${formatRatioPart(reuseValue)}</span><span class="sep">/</span><span class="${posHot ? "hot" : ""}">${formatRatioPart(positionValue)}</span></span>`
      );
    }
    if (badgeStr) parts.push(`<span class="axiom-tp-badge">${badgeStr}</span>`);
    if (reason) {
      const safe = String(reason).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
      parts.push(`<span class="axiom-tp-reason" title="${safe}">${safe}</span>`);
    }
    for (const badge of volumeBadges) {
      parts.push(`<span class="axiom-wl-volume-badge" title="${badge.title}" style="color:${badge.color};border-color:${hexToRgba(badge.color,0.45)};">${badge.label}</span>`);
    }
    // Twitter group
    const twParts = [];
    if (twHandle) {
      const h = String(twHandle).replace(/^@/, "");
      twParts.push(`<a class="axiom-tp-tw-handle" href="https://x.com/${h}" target="_blank" rel="noopener noreferrer">@${h}</a>`);
    }
    if (twVolFormatted) {
      twParts.push(`<span class="axiom-tp-tw-vol">$${twVolFormatted}</span>`);
    }
    if (twParts.length) {
      // After the volume, mirroring the feed row.
      if (showTwitterPreviousLaunch) {
        twParts.push(`<span class="axiom-tp-age axiom-tp-tw-age">${twAgeText}</span>`);
      }
      parts.push(`<span class="axiom-tp-group">${twParts.join("")}</span>`);
    }
    // Dev group
    const devParts = [];
    if (devVolFormatted) {
      devParts.push(`<span class="axiom-tp-dev-vol">$${devVolFormatted}</span>`);
    }
    // Between the volume and the fee list, mirroring the feed row. Gated on
    // payload so the dev group does not appear as a bare "👨‍🍳 -" on an overlay
    // that only has a K prediction score or a reason to show.
    if (showDevPreviousLaunch && payload) {
      devParts.push(`<span class="axiom-tp-age axiom-tp-dev-age">${devAgeText}</span>`);
    }
    if (devFees.length) {
      const feesHtml = devFees
        .map((num, i) => {
          const part = formatRatioPart(num);
          const isHi = feeHighlightThreshold > 0 && num >= feeHighlightThreshold;
          const style = isHi
            ? `color:${feeHighlightColor};background:${hexToRgba(feeHighlightColor, 0.18)};border-radius:3px;padding:0 3px;`
            : "";
          const sep = i > 0 ? `<span style="color:#4a6080;margin:0 2px">/</span>` : "";
          return `${sep}<span style="${style}">${part}</span>`;
        })
        .join("");
      devParts.push(`<span class="axiom-tp-dev-fees">${feesHtml}</span>`);
    }
    if (devParts.length) {
      parts.push(`<span class="axiom-tp-group axiom-tp-group-dev">👨‍🍳 ${devParts.join("")}</span>`);
    }

    root.innerHTML =
      `<div class="axiom-tp-content">${parts.join("")}</div>` +
      `<button class="axiom-tp-toggle" title="${_tpCollapsed ? "Expand" : "Collapse"}">${_tpCollapsed ? "▸" : "◂"}</button>`;

    root.querySelector(".axiom-tp-toggle").addEventListener("click", () => {
      _tpCollapsed = !_tpCollapsed;
      root.classList.toggle("collapsed", _tpCollapsed);
      const btn = root.querySelector(".axiom-tp-toggle");
      if (btn) { btn.textContent = _tpCollapsed ? "▸" : "◂"; btn.title = _tpCollapsed ? "Expand" : "Collapse"; }
      root.dataset.sig = "";
    });
  }

  // Hydration uses its own message path: historical ratings never trigger actions.
  const pulseReadyState = new Map();
  const pulseReadyLive = { payload: new Map(), kPrediction: new Map() };
  let pulseReadyTimer = null;
  let pulseReadyFlight = null;
  let pulseReadySequence = 0;

  function pulseEntryKeys(payload) {
    const keys = [];
    const token = normalizeDev(payload?.token_address ?? payload?.tokenAddress);
    const pair = normalizeDev(payload?.pair_address ?? payload?.pairAddress);
    if (token) keys.push(`token:${token}`);
    if (pair) keys.push(`pair:${pair}`);
    return keys;
  }

  function markPulseLive(kind, payload) {
    const map = pulseReadyLive[kind];
    for (const key of pulseEntryKeys(payload)) map.set(key, Date.now());
    if (map.size > 2000) {
      for (const key of [...map.keys()].slice(0, map.size - 1000)) map.delete(key);
    }
  }

  function pulseHasNewerLive(kind, payload, requestedAt) {
    return pulseEntryKeys(payload).some((key) => (pulseReadyLive[kind].get(key) || 0) >= requestedAt);
  }

  function applyPulseReadyEntry(entry, requestedAt) {
    const stored = entry.payload || {};
    const payload = { ...stored, token_address: entry.token_address || stored.token_address,
      pair_address: stored.pair_address || entry.k_prediction?.pair_address };
    if (entry.payload && !pulseHasNewerLive("payload", payload, requestedAt)) {
      ingestVolumePayload(payload, "b");
      applyWlMeta(payload, entry.meta || {});
    }
    if (entry.k_prediction && !pulseHasNewerLive("kPrediction", payload, requestedAt)) {
      ingestKPrediction({
        ...payload,
        update_type: entry.k_prediction.update_type || entry.k_prediction.source || entry.k_prediction.input_stage ||
          (entry.k_prediction.rank === 1 ? "sol_update_a" : "sol_update_b"),
        prediction: entry.k_prediction,
      }, "ready");
    }
  }

  function finishPulseReady(response) {
    const flight = pulseReadyFlight;
    if (!flight || response.requestId !== flight.id) return;
    clearTimeout(flight.timeout);
    pulseReadyFlight = null;
    const entries = response.success && Array.isArray(response.entries) ? response.entries : [];
    const complete = new Set();
    for (const entry of entries) {
      applyPulseReadyEntry(entry, flight.requestedAt);
      if (entry.payload && entry.k_prediction) {
        for (const key of pulseEntryKeys({ token_address: entry.token_address,
          pair_address: entry.payload.pair_address })) complete.add(key);
      }
    }
    const now = Date.now();
    for (const key of flight.keys) {
      const state = pulseReadyState.get(key);
      if (!state) continue;
      state.attempts += 1;
      state.nextAt = now + (complete.has(key) ? 300000 : Math.min(60000, 2000 * 2 ** (state.attempts - 1)));
    }
    requestScan();
  }

  function collectPulseReady(rows) {
    if ((location.pathname !== "/pulse" && !isTokenPage()) || window !== window.top) return;
    const now = Date.now();
    // Also hydrate a token opened directly, without first visiting Pulse.
    // Axiom URLs can identify a mint or a pair; resolve either via one batch.
    const pageAddress = location.pathname.split("/")[2] || "";
    const candidates = location.pathname === "/pulse"
      ? rows.map((row) => { const token = getRowTokenAddress(row); return {token, pair: token ? "" : getRowPairAddress(row)}; })
      : [{token: pageAddress, pair: ""}, {token: "", pair: pageAddress}];
    for (const {token, pair} of candidates) {
      const address = token || pair;
      if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(address)) continue;
      const kind = token ? "token" : "pair";
      const key = `${kind}:${normalizeDev(address)}`;
      const state = pulseReadyState.get(key) || { kind, address, attempts: 0, nextAt: 0 };
      state.seenAt = now;
      pulseReadyState.set(key, state);
    }
    if (pulseReadyState.size > 500) {
      for (const [key, state] of pulseReadyState) {
        if (now - state.seenAt > 60000) pulseReadyState.delete(key);
      }
    }
    if (pulseReadyFlight || pulseReadyTimer) return;
    if (![...pulseReadyState.values()].some((s) => s.seenAt === now && s.nextAt <= now)) return;
    pulseReadyTimer = setTimeout(() => {
      pulseReadyTimer = null;
      if ((location.pathname !== "/pulse" && !isTokenPage()) || pulseReadyFlight) return;
      const started = Date.now();
      const selected = [...pulseReadyState].filter(([, s]) => started - s.seenAt < 1500 && s.nextAt <= started).slice(0, 100);
      if (!selected.length) return;
      const requestId = ++pulseReadySequence;
      pulseReadyFlight = { id: requestId, requestedAt: started, keys: selected.map(([key]) => key),
        timeout: setTimeout(() => finishPulseReady({ requestId, success: false }), 12000) };
      window.postMessage({ source: SOURCE, type: "PULSE_READY_REQUEST", requestId,
        tokenAddresses: selected.filter(([, s]) => s.kind === "token").map(([, s]) => s.address),
        pairAddresses: selected.filter(([, s]) => s.kind === "pair").map(([, s]) => s.address),
      }, "*");
    }, 250);
  }


  function scanRows() {
    scanTokenPage();
    const rows = queryAllDeep(SELECTORS.newPairsRow);
    for (const row of rows) {
      const tokenAddress = getRowTokenAddress(row);
      if (tokenAddress) {
        const addrKey = normalizeDev(tokenAddress);
        // The handle never changes for a token, so resolve it once — the fallback
        // path in findTwitterHandleInRow serializes the whole row's textContent.
        if (!twitterByToken.has(addrKey)) {
          const handle = findTwitterHandleInRow(row);
          if (handle) twitterByToken.set(addrKey, handle);
        }
      }
      if (TEST_MODE) {
        addBadge(row);
        continue;
      }
      addBadge(row);
      updateRowVolumes(row);
      updateQuickBuyFees(row);
      updateKPredictionOverlay(row);
    }
    collectPulseReady(rows);
  }

  // The page mutates on every websocket tick, so raw mutation/message events
  // would run a scan on nearly every frame. Collapse bursts into one scan per
  // MIN_SCAN_GAP_MS — still well below what a human perceives as lag.
  const MIN_SCAN_GAP_MS = 120;
  let scanPending = false;
  let lastScanAt = 0;

  function runScan() {
    scanPending = false;
    lastScanAt = Date.now();
    scanRows();
  }

  function requestScan() {
    if (scanPending) return;
    scanPending = true;
    const since = Date.now() - lastScanAt;
    if (since >= MIN_SCAN_GAP_MS) {
      requestAnimationFrame(runScan);
    } else {
      setTimeout(() => requestAnimationFrame(runScan), MIN_SCAN_GAP_MS - since);
    }
  }

  function scheduleScan() {
    if (scanTimer) return;
    scanTimer = setInterval(requestScan, 800);
  }

  function initObserver() {
    const observer = new MutationObserver(requestScan);
    observer.observe(document.documentElement, {
      childList: true,
      subtree: true,
    });
  }

  function initTranslateHover() {
    document.addEventListener("mouseover", (e) => {
      const target = e.target;
      if (!(target instanceof Element)) return;
      const quill = target.closest("i.ri-quill-pen-line");
      const community = target.closest("i.ri-group-3-line");
      const account = target.closest("i.ri-user-line");
      if (quill || community || account) {
        const rowEl = target.closest(SELECTORS.newPairsRow);
        if (rowEl) {
          const iconType = quill ? "tweet" : community ? "community" : "account";
          logHoverPreview(rowEl, iconType);
          startTooltipProbe(iconType);
          setTimeout(() => logTooltipText(iconType), 150);
        }
      }
    });
  }

  window.addEventListener("message", (event) => {
    if (!event?.data || event.data.source !== SOURCE) return;
    if (event.data.type === "PULSE_READY_RESPONSE") {
      finishPulseReady(event.data);
      return;
    }
    if (event.data.type === "WL_UPDATE") {
      const payload = event.data.payload || {};
      if (payload.positionThreshold !== undefined) {
        const n = Number(payload.positionThreshold);
        if (Number.isFinite(n)) positionThreshold = n;
      }
      if (payload.reuseThreshold !== undefined) {
        const n = Number(payload.reuseThreshold);
        if (Number.isFinite(n)) reuseThreshold = n;
      }
      if (payload.quickBuyFeesEnabled !== undefined) {
        quickBuyFeesEnabled = payload.quickBuyFeesEnabled !== false;
      }
      if (payload.showDevVolume !== undefined) showDevVolume = payload.showDevVolume !== false;
      if (payload.showDevPreviousLaunch !== undefined) showDevPreviousLaunch = payload.showDevPreviousLaunch !== false;
      if (payload.showTwitterVolume !== undefined) showTwitterVolume = payload.showTwitterVolume !== false;
      if (payload.showTwitterPreviousLaunch !== undefined) showTwitterPreviousLaunch = payload.showTwitterPreviousLaunch !== false;
      if (payload.showUpdateBDelay !== undefined) showUpdateBDelay = payload.showUpdateBDelay !== false;
      if (payload.feeHighlightThreshold !== undefined) {
        const n = Number(payload.feeHighlightThreshold);
        if (Number.isFinite(n)) feeHighlightThreshold = n;
      }
      if (payload.feeHighlightColor) feeHighlightColor = payload.feeHighlightColor;
      if (payload.feeTokenCount !== undefined) {
        const n = Number(payload.feeTokenCount);
        if (Number.isFinite(n) && n >= 1) feeTokenCount = Math.round(n);
      }
      if (payload.showTrustBadge !== undefined) showTrustBadge = payload.showTrustBadge !== false;
      if (payload.showDevVolBadge !== undefined) showDevVolBadge = payload.showDevVolBadge !== false;
      if (payload.showTwitterVolBadge !== undefined) showTwitterVolBadge = payload.showTwitterVolBadge !== false;
      if (payload.devVolBadgeThreshold !== undefined) {
        const n = Number(payload.devVolBadgeThreshold);
        if (Number.isFinite(n)) devVolBadgeThreshold = Math.max(0, n);
      }
      if (payload.twitterVolBadgeThreshold !== undefined) {
        const n = Number(payload.twitterVolBadgeThreshold);
        if (Number.isFinite(n)) twitterVolBadgeThreshold = Math.max(0, n);
      }
      if (/^#[0-9a-f]{6}$/i.test(payload.devVolBadgeColor || "")) devVolBadgeColor = payload.devVolBadgeColor;
      if (/^#[0-9a-f]{6}$/i.test(payload.twitterVolBadgeColor || "")) twitterVolBadgeColor = payload.twitterVolBadgeColor;
      requestScan();
      return;
    }
    if (event.data.type === "K_PREDICTION_CACHE") {
      const cache = event.data.payload || {};
      for (const entry of Object.values(cache)) {
        const token = normalizeDev(entry?.token_address);
        const pair = normalizeDev(entry?.pair_address);
        if ((token && kPredictionByToken.has(token)) || (pair && kPredictionByPair.has(pair))) continue;
        ingestKPrediction(entry, "cache");
      }
      requestScan();
      return;
    }
    if (event.data.type === "WS_CACHE_RESPONSE") {
      const cache = event.data.payload || {};
      for (const entry of Object.values(cache)) {
        if (!entry || typeof entry !== "object") continue;
        // wsMem merges sol_update_a + sol_update_b content, so always treat as 'b'
        // to ensure all fields (twitter_vol, name_ticker_usage, etc.) are extracted
        ingestVolumePayload(entry.content || {}, "b");
        applyWlMeta(entry.content || {}, entry.meta || {});
      }
      requestScan();
      return;
    }
    if (event.data.type === "WS_STATUS") {
      const payload = event.data.payload || {};
      wsStatus = payload.status || "unknown";
      return;
    }
    if (event.data.type === "WS_LOCAL_UPDATE") {
      const payload = event.data.payload || {};
      if (payload.type === "k_prediction") {
        markPulseLive("kPrediction", payload);
        ingestKPrediction(payload, "live");
        requestScan();
        return;
      }
      const raw = payload.raw || "";
      const parsed = tryParseMessage(raw);
      if (!parsed) return;
      const normalized = normalizeWsPayload(parsed);
      const messageType = payload.type || normalized.type || "";
      const content = normalized.content ? { ...normalized.content } : null;
      if (!content) return;
      if (messageType === "sol_update_b" && Number.isFinite(Number(payload.update_b_delay_seconds))) {
        content.update_b_delay_seconds = Number(payload.update_b_delay_seconds);
      }
      if (messageType === "sol_update_a") {
        markPulseLive("payload", content);
        ingestVolumePayload(content, "a");
        applyWlMeta(content, payload);
      } else if (messageType === "sol_update_b") {
        markPulseLive("payload", content);
        ingestVolumePayload(content, "b");
        applyWlMeta(content, payload);
      } else {
        ingestVolumePayload(content, "b");
      }
      requestScan();
      return;
    }
    if (event.data.type === "SOL_UPDATE_B") {
      const payload = event.data.payload || {};
      markPulseLive("payload", payload);
      ingestVolumePayload(payload, "b");
      requestScan();
    }
  });


  hookWorker();
  initObserver();
  if (DEBUG_PREVIEW) initTranslateHover();
  cleanupTriggerReasonBadges();
  scanRows();
  scheduleScan();
})();
