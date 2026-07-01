const state = {
  activeTab: "overview",
  timer: null,
  lastSnapshot: null,
  apiMode: "local",
};

const DATA_API = "https://data-api.polymarket.com";
const GAMMA_API = "https://gamma-api.polymarket.com";

const walletInput = document.getElementById("walletInput");
const intervalSelect = document.getElementById("intervalSelect");
const autoRefresh = document.getElementById("autoRefresh");
const saveWalletBtn = document.getElementById("saveWalletBtn");
const refreshBtn = document.getElementById("refreshBtn");
const apiStatus = document.getElementById("apiStatus");
const lastUpdated = document.getElementById("lastUpdated");
const errorBox = document.getElementById("errorBox");

function usd(value) {
  const number = Number(value || 0);
  return number.toLocaleString("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: Math.abs(number) >= 1000 ? 0 : 2,
  });
}

function pct(value) {
  const number = Number(value || 0);
  return `${number.toFixed(2)}%`;
}

function compact(value) {
  const number = Number(value || 0);
  return number.toLocaleString("en-US", { maximumFractionDigits: 2 });
}

function when(epochSeconds) {
  if (!epochSeconds) return "-";
  const date = new Date(Number(epochSeconds) * 1000);
  return date.toLocaleString("zh-CN", { hour12: false });
}

function dateText(value) {
  if (!value) return "-";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "-";
  return date.toLocaleString("zh-CN", { hour12: false });
}

function setStatus(text, mode = "idle") {
  apiStatus.textContent = text;
  apiStatus.className = `status ${mode}`;
}

function showError(message) {
  if (!message) {
    errorBox.classList.add("hidden");
    errorBox.textContent = "";
    return;
  }
  errorBox.textContent = message;
  errorBox.classList.remove("hidden");
}

function savedWallet() {
  const params = new URLSearchParams(window.location.search);
  return params.get("address") || localStorage.getItem("polymarket_wallet") || "";
}

function validateAddress(address) {
  return /^0x[a-fA-F0-9]{40}$/.test(address);
}

async function loadConfig() {
  try {
    const response = await fetch("/api/config", { cache: "no-store" });
    if (!response.ok) throw new Error("Local API unavailable");
    const config = await response.json();
    const wallet = savedWallet() || config.defaultWallet || "";
    walletInput.value = wallet;
    state.apiMode = "local";
  } catch (_) {
    walletInput.value = savedWallet();
    state.apiMode = "direct";
  }
}

function dataUrl(path, params) {
  const query = new URLSearchParams(params);
  return `${DATA_API}${path}?${query.toString()}`;
}

function gammaUrl(path, params) {
  const query = new URLSearchParams(params);
  return `${GAMMA_API}${path}?${query.toString()}`;
}

async function fetchJson(url) {
  const response = await fetch(url, {
    cache: "no-store",
    headers: { Accept: "application/json" },
  });
  if (!response.ok) {
    const text = await response.text();
    throw new Error(text || `请求失败 ${response.status}`);
  }
  return response.json();
}

function num(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function buildAccountSnapshot(address, value, positions, activity, trades) {
  const positionValue = value && value[0] ? num(value[0].value) : 0;
  const computedPositionValue = positions.reduce((sum, item) => sum + num(item.currentValue), 0);
  const initialValue = positions.reduce((sum, item) => sum + num(item.initialValue), 0);
  const unrealizedPnl = positions.reduce((sum, item) => sum + num(item.cashPnl), 0);
  const realizedPnl = positions.reduce((sum, item) => sum + num(item.realizedPnl), 0);
  const totalBought = positions.reduce((sum, item) => sum + num(item.totalBought), 0);
  const redeemableValue = positions
    .filter((item) => item.redeemable)
    .reduce((sum, item) => sum + num(item.currentValue), 0);
  const mergeableCount = positions.filter((item) => item.mergeable).length;
  const largestMarket = positions.reduce((largest, item) => {
    return num(item.currentValue) > num(largest.currentValue) ? item : largest;
  }, {});

  return {
    address,
    updatedAt: Math.floor(Date.now() / 1000),
    summary: {
      positionValue: positionValue || computedPositionValue,
      computedPositionValue,
      initialValue,
      unrealizedPnl,
      realizedPnl,
      totalBought,
      positionsCount: positions.length,
      redeemableValue,
      mergeableCount,
      largestMarket: {
        title: largestMarket.title || "",
        outcome: largestMarket.outcome || "",
        currentValue: num(largestMarket.currentValue),
        cashPnl: num(largestMarket.cashPnl),
      },
      cashBalanceStatus: "not_connected",
    },
    positions,
    activity,
    trades,
  };
}

async function fetchDirectAccount(address) {
  const [value, positions, activity, trades] = await Promise.all([
    fetchJson(dataUrl("/value", { user: address })),
    fetchJson(
      dataUrl("/positions", {
        user: address,
        limit: 500,
        offset: 0,
        sizeThreshold: 0,
        sortBy: "CURRENT",
        sortDirection: "DESC",
      })
    ),
    fetchJson(
      dataUrl("/activity", {
        user: address,
        limit: 80,
        offset: 0,
        sortBy: "TIMESTAMP",
        sortDirection: "DESC",
      })
    ),
    fetchJson(
      dataUrl("/trades", {
        user: address,
        limit: 80,
        offset: 0,
        takerOnly: "false",
      })
    ),
  ]);

  return buildAccountSnapshot(address, value, positions, activity, trades);
}

function parseList(value) {
  if (Array.isArray(value)) return value;
  if (typeof value !== "string") return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [];
  } catch (_) {
    return [];
  }
}

function buildRadar(markets) {
  const now = Date.now();
  const candidates = [];

  for (const market of markets) {
    const endDate = market.endDate || market.end_date;
    const endMs = endDate ? new Date(endDate).getTime() : Number.NaN;
    if (!Number.isFinite(endMs)) continue;

    const hoursLeft = (endMs - now) / 36e5;
    if (hoursLeft < 0 || hoursLeft > 24) continue;

    const prices = parseList(market.outcomePrices).map((item) => num(item, NaN));
    const outcomes = parseList(market.outcomes);
    if (prices.length < 2 || outcomes.length < 2) continue;

    const leadingPrice = Math.max(...prices);
    const winnerIndex = prices.indexOf(leadingPrice);
    const liquidity = num(market.liquidity);
    const volume = num(market.volume);
    if (leadingPrice < 0.55 || leadingPrice > 0.86 || liquidity < 250) continue;

    const hoursScore = Math.max(0, 1 - Math.abs(hoursLeft - 6) / 18);
    const priceScore = Math.max(0, 1 - Math.abs(leadingPrice - 0.7) / 0.2);
    const liquidityScore = Math.min(1, liquidity / 5000);
    const score = Math.round(100 * (0.42 * priceScore + 0.36 * hoursScore + 0.22 * liquidityScore));

    candidates.push({
      id: market.id,
      question: market.question,
      slug: market.slug,
      endDate,
      hoursLeft: Number(hoursLeft.toFixed(2)),
      leadingOutcome: outcomes[winnerIndex],
      leadingPrice,
      liquidity,
      volume,
      resolutionSource: market.resolutionSource || "",
      score,
    });
  }

  candidates.sort((a, b) => b.score - a.score);
  return { updatedAt: Math.floor(Date.now() / 1000), candidates: candidates.slice(0, 60) };
}

async function fetchDirectRadar() {
  const markets = await fetchJson(
    gammaUrl("/markets", {
      limit: 300,
      active: "true",
      closed: "false",
      order: "endDate",
      ascending: "true",
    })
  );
  return buildRadar(markets);
}

function pnlClass(value) {
  const n = Number(value || 0);
  if (n > 0) return "positive";
  if (n < 0) return "negative";
  return "";
}

function renderOverview(snapshot) {
  const summary = snapshot.summary || {};
  const initial = Number(summary.initialValue || 0);
  const unrealized = Number(summary.unrealizedPnl || 0);
  const unrealizedPercent = initial ? (unrealized / initial) * 100 : 0;

  document.getElementById("positionValue").textContent = usd(summary.positionValue);
  document.getElementById("unrealizedPnl").textContent = usd(unrealized);
  document.getElementById("unrealizedPnl").className = pnlClass(unrealized);
  document.getElementById("unrealizedPct").textContent = pct(unrealizedPercent);
  document.getElementById("unrealizedPct").className = pnlClass(unrealized);
  document.getElementById("realizedPnl").textContent = usd(summary.realizedPnl);
  document.getElementById("realizedPnl").className = pnlClass(summary.realizedPnl);
  document.getElementById("positionsCount").textContent = compact(summary.positionsCount);
  document.getElementById("totalBought").textContent = usd(summary.totalBought);
  document.getElementById("redeemableValue").textContent = usd(summary.redeemableValue);
  document.getElementById("mergeableCount").textContent = compact(summary.mergeableCount);

  const largest = summary.largestMarket || {};
  const target = document.getElementById("largestMarket");
  if (!largest.title) {
    target.className = "largest-market muted";
    target.textContent = "暂无持仓";
  } else {
    target.className = "largest-market";
    target.innerHTML = `
      <strong>${escapeHtml(largest.title)}</strong>
      <span>${escapeHtml(largest.outcome || "-")} · ${usd(largest.currentValue)}</span>
      <span class="${pnlClass(largest.cashPnl)}">PnL ${usd(largest.cashPnl)}</span>
    `;
  }
}

function renderPositions(positions) {
  const body = document.getElementById("positionsBody");
  if (!positions || positions.length === 0) {
    body.innerHTML = `<tr><td colspan="8" class="empty">暂无持仓</td></tr>`;
    return;
  }

  body.innerHTML = positions
    .map((position) => {
      const pnl = Number(position.cashPnl || 0);
      const slug = position.slug || position.eventSlug;
      const link = slug ? `https://polymarket.com/event/${slug}` : "";
      const title = escapeHtml(position.title || "-");
      return `
        <tr>
          <td>
            <div class="market-title">${link ? `<a href="${link}" target="_blank" rel="noreferrer">${title}</a>` : title}</div>
            <div class="subtle">${escapeHtml(position.conditionId || "")}</div>
          </td>
          <td><span class="badge">${escapeHtml(position.outcome || "-")}</span></td>
          <td class="numeric">${compact(position.size)}</td>
          <td class="numeric">${compact(position.avgPrice)}</td>
          <td class="numeric">${compact(position.curPrice)}</td>
          <td class="numeric">${usd(position.currentValue)}</td>
          <td class="numeric ${pnlClass(pnl)}">${usd(pnl)}<div class="subtle">${pct(Number(position.percentPnl || 0))}</div></td>
          <td>${dateText(position.endDate)}</td>
        </tr>
      `;
    })
    .join("");
}

function renderActivity(activity, trades) {
  const body = document.getElementById("activityBody");
  const rows = (activity && activity.length ? activity : trades || []).slice(0, 80);
  if (!rows.length) {
    body.innerHTML = `<tr><td colspan="6" class="empty">暂无活动</td></tr>`;
    return;
  }

  body.innerHTML = rows
    .map((item) => {
      const timestamp = item.timestamp || item.time;
      const type = item.type || "TRADE";
      const side = item.side || item.outcome || "-";
      const price = item.price || item.avgPrice || item.curPrice;
      const amount = item.size || item.amount || item.usdcSize || item.value || item.cashAmount;
      const title = item.title || item.marketTitle || item.question || item.slug || "-";
      return `
        <tr>
          <td>${when(timestamp)}</td>
          <td><span class="badge">${escapeHtml(type)}</span></td>
          <td><div class="market-title">${escapeHtml(title)}</div></td>
          <td>${escapeHtml(side)}</td>
          <td class="numeric">${price == null ? "-" : compact(price)}</td>
          <td class="numeric">${amount == null ? "-" : compact(amount)}</td>
        </tr>
      `;
    })
    .join("");
}

function renderRadar(data) {
  const body = document.getElementById("radarBody");
  const candidates = data.candidates || [];
  if (!candidates.length) {
    body.innerHTML = `<tr><td colspan="7" class="empty">暂无符合条件的临近结算候选</td></tr>`;
    return;
  }

  body.innerHTML = candidates
    .map((item) => {
      const url = item.slug ? `https://polymarket.com/event/${item.slug}` : "";
      const title = escapeHtml(item.question || "-");
      return `
        <tr>
          <td><span class="badge">${item.score}</span></td>
          <td>
            <div class="market-title">${url ? `<a href="${url}" target="_blank" rel="noreferrer">${title}</a>` : title}</div>
            <div class="subtle">${escapeHtml(item.resolutionSource || "No resolution source in API")}</div>
          </td>
          <td>${escapeHtml(item.leadingOutcome || "-")}</td>
          <td class="numeric">${compact(item.leadingPrice)}</td>
          <td class="numeric">${compact(item.hoursLeft)}h</td>
          <td class="numeric">${usd(item.liquidity)}</td>
          <td class="numeric">${usd(item.volume)}</td>
        </tr>
      `;
    })
    .join("");
}

function renderSnapshot(snapshot) {
  state.lastSnapshot = snapshot;
  renderOverview(snapshot);
  renderPositions(snapshot.positions || []);
  renderActivity(snapshot.activity || [], snapshot.trades || []);
  lastUpdated.textContent = `更新 ${dateText(snapshot.updatedAt * 1000)}`;
}

async function refreshAccount() {
  const address = walletInput.value.trim();
  if (!validateAddress(address)) {
    setStatus("等待地址", "idle");
    showError("请输入有效的钱包地址：0x 开头，后面 40 位十六进制字符。");
    return;
  }

  showError("");
  setStatus("刷新中", "idle");

  try {
    let data;
    if (state.apiMode === "local") {
      const response = await fetch(`/api/account?address=${encodeURIComponent(address)}`);
      data = await response.json();
      if (!response.ok) throw new Error(data.error || data.detail || "账户接口请求失败");
    } else {
      data = await fetchDirectAccount(address);
    }
    renderSnapshot(data);
    setStatus("在线", "ok");
  } catch (error) {
    setStatus("异常", "bad");
    showError(error.message);
  }
}

async function refreshRadar() {
  const body = document.getElementById("radarBody");
  body.innerHTML = `<tr><td colspan="7" class="empty">正在刷新候选...</td></tr>`;
  try {
    let data;
    if (state.apiMode === "local") {
      const response = await fetch("/api/settlement-candidates");
      data = await response.json();
      if (!response.ok) throw new Error(data.error || "雷达接口请求失败");
    } else {
      data = await fetchDirectRadar();
    }
    renderRadar(data);
  } catch (error) {
    body.innerHTML = `<tr><td colspan="7" class="empty">${escapeHtml(error.message)}</td></tr>`;
  }
}

function resetTimer() {
  if (state.timer) clearInterval(state.timer);
  if (!autoRefresh.checked) return;
  state.timer = setInterval(() => {
    refreshAccount();
    if (state.activeTab === "radar") refreshRadar();
  }, Number(intervalSelect.value));
}

function switchTab(tabName) {
  state.activeTab = tabName;
  document.querySelectorAll(".tab").forEach((tab) => {
    tab.classList.toggle("active", tab.dataset.tab === tabName);
  });
  document.querySelectorAll(".view").forEach((view) => {
    view.classList.toggle("active", view.id === tabName);
  });
  const titles = {
    overview: "账户概览",
    positions: "持仓明细",
    activity: "账户活动",
    radar: "临近结算雷达",
  };
  document.getElementById("pageTitle").textContent = titles[tabName] || "账户概览";
  if (tabName === "radar") refreshRadar();
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

saveWalletBtn.addEventListener("click", () => {
  const address = walletInput.value.trim();
  if (!validateAddress(address)) {
    showError("钱包地址格式不对。");
    return;
  }
  localStorage.setItem("polymarket_wallet", address);
  refreshAccount();
});

refreshBtn.addEventListener("click", () => {
  refreshAccount();
  if (state.activeTab === "radar") refreshRadar();
});

intervalSelect.addEventListener("change", resetTimer);
autoRefresh.addEventListener("change", resetTimer);

document.querySelectorAll(".tab").forEach((tab) => {
  tab.addEventListener("click", () => switchTab(tab.dataset.tab));
});

loadConfig().then(() => {
  if (walletInput.value.trim()) refreshAccount();
  resetTimer();
});
