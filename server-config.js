// Shared server address parsing for popup, Checker and the service worker.
globalThis.BlackCarrotServer = {
  normalize(value) {
    const raw = String(value || '').trim();
    if (!raw) return '';
    const url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : 'http://' + raw);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password ||
        url.pathname !== '/' || url.search || url.hash) {
      throw new Error('Enter a server IP or HTTP(S) address without a path or credentials.');
    }
    return url.origin;
  },
  websocket(base) { return base.replace(/^http/, 'ws'); },
  permission(base) { return base + '/*'; },
};
