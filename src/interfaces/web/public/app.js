// Market Sentinel dashboard client. Vanilla JS, no build step.
// Auth is handled by the ms_dash cookie (set during /dashboard?token= bootstrap),
// so same-origin fetch() and EventSource() requests are authorized automatically.

const $ = (id) => document.getElementById(id);

// --- Formatting helpers ---
function fmtPrice(n) {
  if (n == null) return "—";
  if (n >= 1000) return "$" + n.toLocaleString("en-US", { maximumFractionDigits: 0 });
  if (n >= 1) return "$" + n.toFixed(2);
  if (n >= 0.01) return "$" + n.toFixed(4);
  return "$" + n.toFixed(6);
}
function fmtPct(n) {
  if (n == null) return "";
  return (n >= 0 ? "+" : "") + n.toFixed(2) + "%";
}
function pctClass(n) {
  if (n == null) return "flat";
  return n > 0 ? "up" : n < 0 ? "down" : "flat";
}
function esc(s) {
  const d = document.createElement("div");
  d.textContent = s == null ? "" : String(s);
  return d.innerHTML;
}

// --- Rendering ---
const tileBySymbol = {};

function renderTiles(prices) {
  const root = $("tiles");
  root.innerHTML = "";
  if (!prices.length) {
    root.innerHTML = '<div class="empty">No watchlist symbols. Add some via Discord or MCP.</div>';
    return;
  }
  for (const p of prices) {
    const tile = document.createElement("div");
    tile.className = "tile";
    tile.innerHTML =
      `<div class="sym">${esc(p.symbol)}</div>` +
      `<div class="price">${fmtPrice(p.price)}</div>` +
      `<div class="chg ${pctClass(p.changePercent24h)}">${fmtPct(p.changePercent24h)}</div>`;
    root.appendChild(tile);
    tileBySymbol[p.symbol.toUpperCase()] = tile;
  }
}

function updateTilePrice(symbol, price) {
  const tile = tileBySymbol[symbol.toUpperCase()];
  if (!tile) return;
  const priceEl = tile.querySelector(".price");
  if (priceEl) priceEl.textContent = fmtPrice(price);
  tile.classList.add("flash");
  setTimeout(() => tile.classList.remove("flash"), 400);
}

function signalCardHtml(s) {
  const call = esc(s.call);
  const label = call.replace("_", " ");
  return (
    `<div class="row1"><span class="call ${call}">${label} · ${esc(s.symbol)}</span>` +
    `<span>${Math.round((s.conviction || 0) * 100)}%</span></div>` +
    `<div class="levels">entry ${fmtPrice(s.entry)} · stop ${fmtPrice(s.stop)} · target ${fmtPrice(s.target)}</div>` +
    `<div class="rationale">${esc(s.rationale)}</div>`
  );
}

const signalCards = {};
function renderSignals(signals) {
  const root = $("signals");
  root.innerHTML = "";
  if (!signals.length) {
    root.innerHTML = '<div class="empty">No signals yet — they appear as the monitor evaluates symbols.</div>';
    return;
  }
  for (const s of signals) upsertSignal(s, root);
}

function upsertSignal(s, rootEl) {
  const root = rootEl || $("signals");
  const empty = root.querySelector(".empty");
  if (empty) empty.remove();
  let card = signalCards[s.symbol.toUpperCase()];
  if (!card) {
    card = document.createElement("div");
    signalCards[s.symbol.toUpperCase()] = card;
    root.prepend(card);
  }
  card.className = "signal-card " + esc(s.call);
  card.innerHTML = signalCardHtml(s);
  card.classList.add("flash");
  setTimeout(() => card.classList.remove("flash"), 600);
}

function renderPortfolio(portfolio) {
  const root = $("portfolio");
  root.innerHTML = "";
  if (!portfolio.length) {
    root.innerHTML = '<div class="empty">No open positions.</div>';
    return;
  }
  for (const p of portfolio) {
    const row = document.createElement("div");
    row.className = "pos";
    row.innerHTML =
      `<span>${esc(p.symbol)} <span class="flat">×${esc(p.quantity)}</span></span>` +
      `<span class="${pctClass(p.pnlPercent)}">${fmtPrice(p.currentPrice)} ${p.pnlPercent != null ? "(" + fmtPct(p.pnlPercent) + ")" : ""}</span>`;
    root.appendChild(row);
  }
}

// --- Data load ---
async function loadSnapshot() {
  try {
    const res = await fetch("/api/snapshot");
    if (!res.ok) {
      if (res.status === 401) {
        document.body.innerHTML = '<p style="padding:40px;text-align:center">Session expired. Reopen the dashboard with your token.</p>';
      }
      return;
    }
    const data = await res.json();
    renderTiles(data.prices || []);
    renderSignals(data.signals || []);
    renderPortfolio(data.portfolio || []);
  } catch (err) {
    console.error("snapshot failed", err);
  }
}

// --- Live stream ---
function connectEvents() {
  const dot = $("conn-dot");
  const label = $("conn-label");
  const es = new EventSource("/events");

  es.onopen = () => { dot.className = "dot dot-on"; label.textContent = "live"; };
  es.onerror = () => { dot.className = "dot dot-err"; label.textContent = "reconnecting…"; };

  es.addEventListener("tick", (e) => {
    try { const t = JSON.parse(e.data); updateTilePrice(t.symbol, t.price); } catch {}
  });
  es.addEventListener("signal", (e) => {
    try { upsertSignal(JSON.parse(e.data)); } catch {}
  });
}

// --- Chat ---
function appendMsg(cls, html) {
  const log = $("chat-log");
  const div = document.createElement("div");
  div.className = "msg " + cls;
  div.innerHTML = html;
  log.appendChild(div);
  log.scrollTop = log.scrollHeight;
  return div;
}

async function sendChat(message) {
  appendMsg("user", esc(message));
  const pending = appendMsg("bot", "…");
  try {
    const res = await fetch("/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message }),
    });
    const data = await res.json();
    pending.remove();
    if (!res.ok) {
      appendMsg("bot", esc(data.error || "Something went wrong."));
      return;
    }
    for (const r of data.responses || []) {
      let html = esc(r.content);
      if (r.chartDataUrl) html += `<img src="${r.chartDataUrl}" alt="chart" />`;
      appendMsg("bot", html);
    }
  } catch (err) {
    pending.remove();
    appendMsg("bot", "Network error. Try again.");
  }
}

$("chat-form").addEventListener("submit", (e) => {
  e.preventDefault();
  const input = $("chat-input");
  const msg = input.value.trim();
  if (!msg) return;
  input.value = "";
  sendChat(msg);
});

// --- Boot ---
loadSnapshot();
connectEvents();
setInterval(loadSnapshot, 60_000); // periodic resync as a safety net
