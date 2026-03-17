/* global Chart */
'use strict';

import { ACTIONS, LOCAL_METAFORGE_ITEMS_URL, METAFORGE_URL, STORAGE_KEYS } from './constants.js';
import { readJson, readNumber, writeJson } from './storage.js';

let stock = readJson(STORAGE_KEYS.stock, []);
let audit = readJson(STORAGE_KEYS.audit, []);
let liquidSeeds = readNumber(STORAGE_KEYS.liquidSeeds, 0);
let priceCache = {};
let apiItems = [];
let allowCustomItems = localStorage.getItem(STORAGE_KEYS.allowCustomItems) === 'true';
let chartInstance = null;
let priceHistoryChart = null;

function genId() {
  return `e${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
}

// ─── Metaforge ────────────────────────────────────────────────────────────────
function loadMetaforgeCache() {
  try {
    const raw = localStorage.getItem(STORAGE_KEYS.metaforgeCache);
    const ts = localStorage.getItem(STORAGE_KEYS.metaforgeCacheTs);
    if (raw) {
      const data = JSON.parse(raw);
      apiItems = Array.isArray(data) ? data : data.data || [];
      const el = document.getElementById('metaforgeStatus');
      if (el) el.textContent = ts ? `Synced ${new Date(+ts).toLocaleString()}` : 'Cached';
    }
  } catch {
    apiItems = [];
  }
}

async function fetchMetaforgeAll() {
  const out = [];
  let page = 1, hasMore = true;
  const maxPages = 200;
  while (hasMore) {
    if (page > maxPages) throw new Error(`Safety stop: exceeded maxPages (${maxPages}).`);
    const res = await fetch(`${METAFORGE_URL}/items?page=${page}&limit=100&minimal=true`);
    if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
    const json = await res.json();
    out.push(...(json.data || []));
    hasMore = json.pagination?.hasNextPage || false;
    page++;
  }
  return out;
}

async function fetchMetaforgeFromLocalFile() {
  const res = await fetch(LOCAL_METAFORGE_ITEMS_URL, { cache: 'no-store' });
  if (!res.ok) throw new Error(`Local metaforge file HTTP ${res.status}`);
  const json = await res.json();
  const data = Array.isArray(json) ? json : json.data || [];
  return Array.isArray(data) ? data : [];
}

function formatFetchErr(e) {
  const msg = (e && (e.message || String(e))) || 'Unknown error';
  if (/failed to fetch/i.test(msg)) return `${msg} (likely CORS blocked by the API)`;
  return msg;
}

async function resyncMetaforge() {
  const btn = document.getElementById('resyncBtn');
  if (btn) { btn.disabled = true; btn.textContent = 'Syncing...'; }
  try {
    apiItems = await fetchMetaforgeAll();
    writeJson(STORAGE_KEYS.metaforgeCache, apiItems);
    localStorage.setItem(STORAGE_KEYS.metaforgeCacheTs, String(Date.now()));
    const el = document.getElementById('metaforgeStatus');
    if (el) el.textContent = `Synced ${new Date().toLocaleString()} (${apiItems.length})`;
  } catch (e) {
    const el = document.getElementById('metaforgeStatus');
    if (el) el.textContent = `Sync failed: ${formatFetchErr(e)}. Tip: on GitHub Pages, use the scheduled GitHub Action to sync into ${LOCAL_METAFORGE_ITEMS_URL}`;
  }
  if (btn) { btn.disabled = false; btn.textContent = 'Resync API'; }
  render();
}

// ─── Item name helpers ────────────────────────────────────────────────────────
// Resolves a typed name to the canonical Metaforge name (case-insensitive match)
function normalizeItemName(input) {
  if (!input || typeof input !== 'string') return input;
  const t = input.trim();
  const match = apiItems.find((i) => (i.name || '').toLowerCase() === t.toLowerCase());
  return match ? match.name : t;
}

// Returns null and shows an alert if the name isn't in the Metaforge list and custom items are off
function validateItemName(raw) {
  const name = normalizeItemName(raw);
  if (allowCustomItems || apiItems.length === 0) return name;
  const known = apiItems.some((i) => (i.name || '').toLowerCase() === name.toLowerCase());
  if (!known) {
    alert(`"${name}" is not in the Metaforge item list.\n\nCheck the spelling, or enable Custom Named Items in Tools → Settings if you need to add non-standard items.`);
    return null;
  }
  return name;
}

// ─── Price cache ──────────────────────────────────────────────────────────────
function buildPriceCache() {
  priceCache = {};
  const sells = audit.filter((a) => a.action === ACTIONS.SELL);
  [...new Set(sells.map((a) => a.name))].forEach((name) => {
    const prices = sells
      .filter((a) => a.name === name)
      .sort((a, b) => b.ts - a.ts)
      .slice(0, 5)
      .map((s) => s.price)
      .sort((a, b) => a - b);
    if (prices.length) {
      const m = Math.floor(prices.length / 2);
      priceCache[name] = prices.length % 2 ? prices[m] : (prices[m - 1] + prices[m]) / 2;
    }
  });
}

// ─── Tab switching ────────────────────────────────────────────────────────────
function switchTab(t) {
  document.querySelectorAll('.tab-content').forEach((e) => e.classList.remove('active'));
  document.querySelectorAll('.nav-btn').forEach((b) => b.classList.remove('active'));
  document.getElementById(`view-${t}`)?.classList.add('active');
  document.getElementById(`nav-${t}`)?.classList.add('active');
  if (t === 'analytics') renderAnalytics();
}

// ─── Render ───────────────────────────────────────────────────────────────────
function render() {
  buildPriceCache();

  const invBody = document.getElementById('inventoryTable');
  const auditBody = document.getElementById('auditTable');
  const barterSelect = document.getElementById('tradeFrom');
  const dataList = document.getElementById('itemOptions');
  const searchQuery = (document.getElementById('invSearch')?.value || '').toLowerCase();

  if (!invBody || !auditBody || !barterSelect || !dataList) return;

  invBody.innerHTML = '';
  auditBody.innerHTML = '';
  dataList.innerHTML = '';
  barterSelect.innerHTML = '<option value="">— Choose item —</option>';

  let totalProfit = 0;
  let assetValuation = 0;

  const grouped = stock.reduce((acc, item) => {
    const k = `${item.name}-${item.source}-${Math.floor(item.cost)}`;
    if (!acc[k]) acc[k] = { ...item, count: 0 };
    acc[k].count++;
    return acc;
  }, {});

  Object.values(grouped)
    .sort((a, b) => a.name.localeCompare(b.name))
    .forEach((g, i) => {
      const mp = priceCache[g.name] || null;
      assetValuation += (mp ?? g.cost) * g.count;
      if (searchQuery && !g.name.toLowerCase().includes(searchQuery)) return;

      const safeId = `item-${i}`;
      const tag = g.source === 'FIR' ? 'tag-fir' : g.source === 'TRD' ? 'tag-trd' : 'tag-buy';
      const fillBtn = mp
        ? `<button class="btn btn-ghost" style="padding:6px 8px;font-size:0.8rem;color:var(--cyan);" title="Fill median price: ${Math.floor(mp).toLocaleString()}" onclick="document.getElementById('p-${safeId}').value=${Math.floor(mp)}">~</button>`
        : '';

      invBody.innerHTML += `<tr>
        <td class="font-mono font-semibold">${g.name}</td>
        <td><span class="tag ${tag}">${g.source}</span></td>
        <td class="font-mono">×${g.count}</td>
        <td class="font-mono text-[var(--muted)]">${Math.floor(g.cost).toLocaleString()}</td>
        <td class="font-mono ${mp ? 'text-[var(--cyan)]' : 'text-[var(--muted)]'}">${mp ? Math.floor(mp).toLocaleString() : '—'}</td>
        <td style="text-align:right;white-space:nowrap;">
          <input type="number" id="q-${safeId}" value="1" min="1" max="${g.count}" style="width:52px;padding:6px;margin-right:2px;display:inline-block">
          <input type="number" id="p-${safeId}" placeholder="Price" style="width:72px;padding:6px;margin-right:2px;display:inline-block">
          ${fillBtn}
          <button class="btn btn-ghost" style="padding:6px 10px;font-size:0.7rem" onclick="sellX('${g.name.replace(/'/g, "\\'")}', '${g.source}', ${g.cost}, '${safeId}')">Sell</button>
          <button class="btn btn-ghost" style="padding:6px 10px;font-size:0.7rem;color:var(--amber)" title="Sell entire stack — auto-fills median price if available" onclick="sellAll('${g.name.replace(/'/g, "\\'")}', '${g.source}', ${g.cost}, '${safeId}')">All</button>
        </td>
      </tr>`;
      barterSelect.innerHTML += `<option value="${g.name}|${g.source}|${g.cost}">${g.name} [${g.source}] ×${g.count}</option>`;
    });

  // Audit log — newest first, with session dividers
  const totalSessions = audit.filter((e) => e.action === ACTIONS.SESSION_START).length;
  let sessionCounter = totalSessions;

  for (let idx = audit.length - 1; idx >= 0; idx--) {
    const entry = audit[idx];

    if (entry.action === ACTIONS.SESSION_START) {
      const time = new Date(entry.ts).toLocaleString([], { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false });
      auditBody.insertAdjacentHTML('beforeend', `<tr class="session-divider"><td colspan="6">⚑ Session ${sessionCounter--} &nbsp;·&nbsp; ${time}</td></tr>`);
      continue;
    }

    const isSell = entry.action === ACTIONS.SELL;
    const isCurrency = entry.action === ACTIONS.CURRENCY;
    const isInitial = entry.action === ACTIONS.INITIAL;
    const isVoid = entry.action === ACTIONS.VOID;
    const isReverted = entry.action === ACTIONS.REVERTED;
    const isBarter = entry.action === ACTIONS.BARTER;
    const isExcluded = isVoid || isReverted;

    const profitDelta =
      isInitial || isVoid || isReverted || isBarter ? 0
      : isCurrency ? entry.price
      : isSell ? (entry.price - entry.cost) * entry.qty
      : 0;

    if (!isExcluded) totalProfit += profitDelta;

    const time = new Date(entry.ts).toLocaleString([], { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false });
    const actClr =
      profitDelta > 0 ? 'color:var(--emerald)'
      : profitDelta < 0 ? 'color:var(--rose)'
      : isInitial ? 'color:var(--cyan)'
      : isExcluded ? 'color:var(--muted)'
      : isBarter ? 'color:#a78bfa'
      : '';

    auditBody.insertAdjacentHTML('beforeend',
      `<tr style="${isExcluded ? 'opacity:0.5' : ''}">
        <td class="font-mono" style="font-size:0.75rem;color:var(--muted)">${time}</td>
        <td style="font-weight:600;font-size:0.75rem;${actClr}">${entry.action}</td>
        <td style="${isExcluded ? 'text-decoration:line-through' : ''}">${entry.name}</td>
        <td class="font-mono" style="color:var(--muted)">${isCurrency || isInitial ? '—' : '×' + entry.qty}</td>
        <td style="text-align:right;font-weight:600;${profitDelta >= 0 ? 'color:var(--amber)' : 'color:var(--rose)'}">${profitDelta !== 0 ? (profitDelta > 0 ? '+' : '') + Math.floor(profitDelta).toLocaleString() : isInitial || isBarter ? Math.floor(entry.price).toLocaleString() : '—'}</td>
        <td style="text-align:right">${!isExcluded && entry.action !== ACTIONS.INITIAL
          ? `<button class="btn btn-ghost" style="padding:2px 6px;font-size:0.65rem" onclick="voidEntry(${idx})">Void</button><button class="btn btn-ghost" style="padding:2px 6px;font-size:0.65rem" onclick="revertEntry(${idx})">Revert</button>`
          : isReverted ? '<span style="font-size:0.7rem;color:var(--muted)">Reverted</span>' : ''}</td>
      </tr>`
    );
  }

  // Datalist for input autocomplete
  const allNames = [...new Set([...stock.map((i) => i.name), ...audit.map((i) => i.name), ...apiItems.map((i) => i.name)])]
    .filter(Boolean).sort();
  allNames.forEach((n) => { dataList.innerHTML += `<option value="${n}">`; });

  document.getElementById('liquidDisplay').textContent = Math.floor(liquidSeeds).toLocaleString();
  document.getElementById('assetValuation').textContent = Math.floor(assetValuation).toLocaleString();
  document.getElementById('netWorth').textContent = Math.floor(liquidSeeds + assetValuation).toLocaleString();
  document.getElementById('totalProfit').textContent = Math.floor(totalProfit).toLocaleString();
  document.getElementById('invCount').textContent = stock.length;

  const randBtn = document.getElementById('randomHistoryBtn');
  if (randBtn) {
    const hasItems = apiItems.length > 0;
    randBtn.disabled = !hasItems;
    randBtn.title = hasItems ? '' : 'Requires Metaforge item list — run the Sync Action first';
    randBtn.style.opacity = hasItems ? '' : '0.4';
    randBtn.style.cursor = hasItems ? '' : 'not-allowed';
  }

  writeJson(STORAGE_KEYS.stock, stock);
  writeJson(STORAGE_KEYS.audit, audit);
  localStorage.setItem(STORAGE_KEYS.liquidSeeds, String(liquidSeeds));
}

// ─── Session tracking ─────────────────────────────────────────────────────────
function startNewSession() {
  audit.push({ id: genId(), ts: Date.now(), action: ACTIONS.SESSION_START, name: 'Session Start', qty: 1, price: 0, cost: 0, source: 'SYS' });
  render();
}

// ─── Inventory actions ────────────────────────────────────────────────────────
function massIngest() {
  const raw = (document.getElementById('bulkText').value || '').trim();
  if (!raw) return;
  raw.split('\n').forEach((line) => {
    const nums = line.match(/\d+/);
    const rawName = line.replace(/\d+/, '').trim();
    if (!rawName) return;
    const qty = nums ? parseInt(nums[0], 10) : 1;
    const text = validateItemName(rawName);
    if (!text) return;
    for (let i = 0; i < qty; i++) stock.push({ name: text, cost: 0, source: 'FIR' });
    audit.push({ id: genId(), ts: Date.now(), action: ACTIONS.RECOVERY, name: text, qty, price: 0, cost: 0, source: 'FIR', revertData: { removeStock: [{ name: text, source: 'FIR', cost: 0, qty }] } });
  });
  document.getElementById('bulkText').value = '';
  setTimeout(() => render(), 0);
}

function buyItem() {
  const name = validateItemName((document.getElementById('buyName').value || '').trim());
  if (!name) return;
  const qty = parseInt(document.getElementById('buyQty').value, 10) || 1;
  const costPer = parseFloat(document.getElementById('buyPrice').value) || 0;
  const total = costPer * qty;
  liquidSeeds -= total;
  for (let i = 0; i < qty; i++) stock.push({ name, cost: costPer, source: 'BUY' });
  audit.push({ id: genId(), ts: Date.now(), action: ACTIONS.PURCHASE, name, qty, price: costPer, cost: costPer, source: 'BUY', revertData: { deltaLiquid: total, removeStock: { name, source: 'BUY', cost: costPer, qty } } });
  document.getElementById('buyName').value = '';
  document.getElementById('buyPrice').value = '';
  render();
}

function sellX(name, source, cost, safeId) {
  const p = parseFloat(document.getElementById(`p-${safeId}`).value);
  const q = parseInt(document.getElementById(`q-${safeId}`).value, 10) || 1;
  if (Number.isNaN(p) || q <= 0) return;
  const matches = stock.filter((i) => i.name === name && i.source === source && Math.floor(i.cost) === Math.floor(cost));
  if (matches.length < q) { alert(`Only ${matches.length} in stock.`); return; }
  let removed = 0;
  for (let i = stock.length - 1; i >= 0 && removed < q; i--) {
    if (stock[i].name === name && stock[i].source === source && Math.floor(stock[i].cost) === Math.floor(cost)) { stock.splice(i, 1); removed++; }
  }
  liquidSeeds += p * q;
  const addBack = [];
  for (let i = 0; i < q; i++) addBack.push({ name, source, cost });
  audit.push({ id: genId(), ts: Date.now(), action: ACTIONS.SELL, name, qty: q, price: p, cost, source, revertData: { deltaLiquid: -(p * q), addStock: addBack } });
  render();
}

function sellAll(name, source, cost, safeId) {
  const qEl = document.getElementById(`q-${safeId}`);
  const pEl = document.getElementById(`p-${safeId}`);
  qEl.value = qEl.max;
  if (!pEl.value && priceCache[name]) pEl.value = Math.floor(priceCache[name]);
  sellX(name, source, cost, safeId);
}

function executeBarter() {
  const fromData = document.getElementById('tradeFrom').value;
  const fromQty = parseInt(document.getElementById('tradeFromQty').value, 10) || 1;
  const toName = (document.getElementById('tradeTo').value || '').trim();
  const toQty = parseInt(document.getElementById('tradeQty').value, 10) || 1;
  if (!fromData || !toName) return;

  const [oldName, oldSrc, oldCost] = fromData.split('|');
  const matches = stock.filter((i) => i.name === oldName && i.source === oldSrc && Math.floor(i.cost) === Math.floor(oldCost));
  if (matches.length < fromQty) return alert('Insufficient stock.');

  const toNorm = validateItemName(toName);
  if (!toNorm) return;

  const unitVal = parseFloat(oldCost) > 0 ? parseFloat(oldCost) : priceCache[oldName] || 0;
  const totalVal = unitVal * fromQty;

  let removed = 0;
  for (let i = stock.length - 1; i >= 0 && removed < fromQty; i--) {
    if (stock[i].name === oldName && stock[i].source === oldSrc && Math.floor(stock[i].cost) === Math.floor(oldCost)) { stock.splice(i, 1); removed++; }
  }

  const costPer = Math.floor(totalVal / toQty);
  for (let i = 0; i < toQty; i++) stock.push({ name: toNorm, cost: costPer, source: 'TRD' });

  const addBack = [];
  for (let i = 0; i < fromQty; i++) addBack.push({ name: oldName, source: oldSrc, cost: parseFloat(oldCost) });

  audit.push({
    id: genId(), ts: Date.now(), action: ACTIONS.BARTER,
    name: `${fromQty}× ${oldName} → ${toQty}× ${toNorm}`,
    qty: toQty, price: totalVal, cost: totalVal, source: 'TRD',
    revertData: { removeStock: { name: toNorm, source: 'TRD', cost: costPer, qty: toQty }, addStock: addBack },
    barterFrom: { name: oldName, source: oldSrc, cost: parseFloat(oldCost), qty: fromQty },
    barterTo: { name: toNorm, qty: toQty },
  });

  document.getElementById('tradeTo').value = '';
  document.getElementById('tradeQty').value = '1';
  document.getElementById('tradeFromQty').value = '1';
  render();
}

function adjustBalance() {
  const amt = parseFloat(document.getElementById('adjAmount').value);
  if (Number.isNaN(amt)) return;
  liquidSeeds += amt;
  audit.push({ id: genId(), ts: Date.now(), action: ACTIONS.ADJUST, name: 'Manual Correction', qty: 1, price: amt, cost: 0, source: 'SYS', revertData: { deltaLiquid: -amt } });
  document.getElementById('adjAmount').value = '';
  render();
}

function voidEntry(idx) {
  if (confirm('Void (cosmetic only)?')) { audit[idx].action = ACTIONS.VOID; render(); }
}

function revertEntry(idx) {
  const e = audit[idx];
  if (!e || [ACTIONS.VOID, ACTIONS.REVERTED, ACTIONS.INITIAL].includes(e.action)) return;
  const rd = e.revertData;
  if (!rd && e.action !== ACTIONS.BARTER) return;
  if (!confirm('Revert this entry? This will undo changes.')) return;
  if (rd) {
    if (rd.deltaLiquid) liquidSeeds += rd.deltaLiquid;
    if (rd.addStock) rd.addStock.forEach((i) => stock.push(i));
    if (rd.removeStock) {
      const arr = Array.isArray(rd.removeStock) ? rd.removeStock : [rd.removeStock];
      arr.forEach((item) => {
        const { name, source, cost, qty } = item;
        const count = qty || 1;
        let removed = 0;
        for (let i = stock.length - 1; i >= 0 && removed < count; i--) {
          if (stock[i].name === name && stock[i].source === (source || 'TRD') && Math.floor(stock[i].cost) === Math.floor(cost || 0)) { stock.splice(i, 1); removed++; }
        }
      });
    }
  } else if (e.action === ACTIONS.BARTER && e.barterFrom && e.barterTo) {
    const from = e.barterFrom, to = e.barterTo;
    const costPer = e.cost / to.qty;
    let removed = 0;
    for (let i = stock.length - 1; i >= 0 && removed < to.qty; i--) {
      if (stock[i].name === to.name && stock[i].source === 'TRD' && Math.floor(stock[i].cost) === Math.floor(costPer)) { stock.splice(i, 1); removed++; }
    }
    for (let i = 0; i < from.qty; i++) stock.push({ name: from.name, source: from.source, cost: from.cost });
  }
  audit[idx].action = ACTIONS.REVERTED;
  render();
}

// ─── Settings ─────────────────────────────────────────────────────────────────
function toggleCustomItems(checkbox) {
  allowCustomItems = checkbox.checked;
  localStorage.setItem(STORAGE_KEYS.allowCustomItems, String(allowCustomItems));
}

// ─── Random history ───────────────────────────────────────────────────────────
function generateRandomHistory() {
  if (apiItems.length === 0) return;
  if (!confirm('Replace all data with random test history?')) return;

  function pick(arr, n) { return [...arr].sort(() => Math.random() - 0.5).slice(0, n); }
  function randInt(min, max) { return min + Math.floor(Math.random() * (max - min + 1)); }
  function randPrice() { return randInt(500, 12000); }

  const now = Date.now(), day = 86400000;
  const ts = (d) => now - (7 - d) * day - Math.random() * day;

  const allNames = apiItems.map((i) => i.name).filter(Boolean);
  const firItems = pick(allNames, 6);
  const buyItemName = pick(allNames.filter((n) => !firItems.includes(n)), 1)[0];
  const sellItem = firItems[Math.floor(Math.random() * firItems.length)];

  audit = []; stock = []; liquidSeeds = 50000;
  audit.push({ id: genId(), ts: ts(0), action: ACTIONS.INITIAL, name: 'Starting Capital', qty: 1, price: 50000, cost: 0, source: 'SYS' });
  audit.push({ id: genId(), ts: ts(0) + 1000, action: ACTIONS.SESSION_START, name: 'Session Start', qty: 1, price: 0, cost: 0, source: 'SYS' });

  firItems.slice(0, 3).forEach((name, d) => {
    const qty = randInt(1, 4);
    for (let i = 0; i < qty; i++) stock.push({ name, cost: 0, source: 'FIR' });
    audit.push({ id: genId(), ts: ts(d + 1), action: ACTIONS.RECOVERY, name, qty, price: 0, cost: 0, source: 'FIR', revertData: { removeStock: [{ name, source: 'FIR', cost: 0, qty }] } });
  });

  audit.push({ id: genId(), ts: ts(3), action: ACTIONS.SESSION_START, name: 'Session Start', qty: 1, price: 0, cost: 0, source: 'SYS' });

  firItems.slice(3).forEach((name, d) => {
    const qty = randInt(1, 4);
    for (let i = 0; i < qty; i++) stock.push({ name, cost: 0, source: 'FIR' });
    audit.push({ id: genId(), ts: ts(d + 3), action: ACTIONS.RECOVERY, name, qty, price: 0, cost: 0, source: 'FIR', revertData: { removeStock: [{ name, source: 'FIR', cost: 0, qty }] } });
  });

  const costPer = randPrice(), bq = randInt(1, 3);
  liquidSeeds -= costPer * bq;
  for (let i = 0; i < bq; i++) stock.push({ name: buyItemName, cost: costPer, source: 'BUY' });
  audit.push({ id: genId(), ts: ts(4), action: ACTIONS.PURCHASE, name: buyItemName, qty: bq, price: costPer, cost: costPer, source: 'BUY', revertData: { deltaLiquid: costPer * bq, removeStock: { name: buyItemName, source: 'BUY', cost: costPer, qty: bq } } });

  const sellPrice = randPrice();
  const sellQty = Math.min(randInt(1, 3), stock.filter((s) => s.name === sellItem).length) || 1;
  let removed = 0;
  for (let i = stock.length - 1; i >= 0 && removed < sellQty; i--) {
    if (stock[i].name === sellItem && stock[i].source === 'FIR') { stock.splice(i, 1); removed++; }
  }
  liquidSeeds += sellPrice * sellQty;
  const ab = [];
  for (let i = 0; i < sellQty; i++) ab.push({ name: sellItem, source: 'FIR', cost: 0 });
  audit.push({ id: genId(), ts: ts(5), action: ACTIONS.SELL, name: sellItem, qty: sellQty, price: sellPrice, cost: 0, source: 'FIR', revertData: { deltaLiquid: -(sellPrice * sellQty), addStock: ab } });

  if (stock.some((s) => s.name === sellItem && s.source === 'FIR')) {
    const sellPrice2 = randPrice();
    let r2 = 0;
    for (let i = stock.length - 1; i >= 0 && r2 < 1; i--) {
      if (stock[i].name === sellItem && stock[i].source === 'FIR') { stock.splice(i, 1); r2++; }
    }
    liquidSeeds += sellPrice2;
    audit.push({ id: genId(), ts: ts(6), action: ACTIONS.SELL, name: sellItem, qty: 1, price: sellPrice2, cost: 0, source: 'FIR', revertData: { deltaLiquid: -sellPrice2, addStock: [{ name: sellItem, source: 'FIR', cost: 0 }] } });
  }

  const adj = randInt(-1000, 1000);
  liquidSeeds += adj;
  audit.push({ id: genId(), ts: ts(6) + 1000, action: ACTIONS.ADJUST, name: 'Manual Correction', qty: 1, price: adj, cost: 0, source: 'SYS', revertData: { deltaLiquid: -adj } });

  render();
}

// ─── Analytics ────────────────────────────────────────────────────────────────
function renderAnalytics() {
  const flipBody = document.getElementById('topFlipBody');
  const firBody = document.getElementById('topFirBody');
  const perBody = document.getElementById('perItemStatsBody');
  const sessionsBody = document.getElementById('sessionsBody');
  if (!flipBody || !firBody || !perBody || !sessionsBody) return;

  flipBody.innerHTML = ''; firBody.innerHTML = ''; perBody.innerHTML = ''; sessionsBody.innerHTML = '';

  const valid = audit.filter((l) => ![ACTIONS.VOID, ACTIONS.REVERTED].includes(l.action));

  const stats = valid.reduce((acc, l) => {
    if (l.action !== ACTIONS.SELL) return acc;
    if (!acc[l.name]) acc[l.name] = { profit: 0, qty: 0, revenue: 0, costBasis: 0, isFIR: l.source === 'FIR' };
    acc[l.name].profit += (l.price - l.cost) * l.qty;
    acc[l.name].qty += l.qty;
    acc[l.name].revenue += l.price * l.qty;
    acc[l.name].costBasis += l.cost * l.qty;
    return acc;
  }, {});

  Object.entries(stats).sort((a, b) => b[1].profit - a[1].profit).forEach(([name, s]) => {
    const row = `<tr><td>${name}</td><td style="text-align:right;color:var(--emerald);font-weight:600">+${Math.floor(s.profit).toLocaleString()}</td></tr>`;
    if (s.isFIR) firBody.innerHTML += row; else flipBody.innerHTML += row;
  });

  Object.entries(stats).sort((a, b) => b[1].profit - a[1].profit).forEach(([name, s]) => {
    const avgP = s.qty ? s.revenue / s.qty : 0;
    const avgC = s.qty ? s.costBasis / s.qty : 0;
    const roi = s.costBasis > 0 ? `${((s.profit / s.costBasis) * 100).toFixed(0)}%` : '—';
    const roiStyle = s.costBasis > 0 ? (s.profit >= 0 ? 'color:var(--emerald)' : 'color:var(--rose)') : 'color:var(--muted)';
    const safeName = name.replace(/'/g, "\\'");
    perBody.innerHTML += `<tr>
      <td class="font-semibold" style="cursor:pointer" onclick="showPriceHistory('${safeName}')" title="View price history">
        <span style="color:var(--cyan);text-decoration:underline dotted;">${name}</span>
      </td>
      <td style="text-align:right">${s.qty}</td>
      <td style="text-align:right" class="font-mono">${Math.floor(s.revenue).toLocaleString()}</td>
      <td style="text-align:right" class="font-mono">${Math.floor(avgP).toLocaleString()}</td>
      <td style="text-align:right;color:var(--muted)" class="font-mono">${Math.floor(avgC).toLocaleString()}</td>
      <td style="text-align:right;color:var(--emerald);font-weight:600">+${Math.floor(s.profit).toLocaleString()}</td>
      <td style="text-align:right;${roiStyle}" class="font-mono">${roi}</td>
    </tr>`;
  });

  // Session history
  const sorted = [...valid].sort((a, b) => a.ts - b.ts);
  const sessions = [];
  let current = null;
  sorted.forEach((e) => {
    if (e.action === ACTIONS.SESSION_START) {
      if (current) sessions.push(current);
      current = { startTs: e.ts, entries: [] };
    } else if (current) {
      current.entries.push(e);
    }
  });
  if (current) sessions.push(current);

  if (sessions.length === 0) {
    sessionsBody.innerHTML = `<tr><td colspan="5" style="text-align:center;color:var(--muted);padding:2rem;font-size:0.85rem;">No sessions yet — hit <strong>⚑ New Session</strong> in Operations before each raid run</td></tr>`;
  } else {
    [...sessions].reverse().forEach((session, i) => {
      const num = sessions.length - i;
      const date = new Date(session.startTs).toLocaleString([], { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false });
      const itemsFound = session.entries.filter((e) => e.action === ACTIONS.RECOVERY).reduce((s, e) => s + e.qty, 0);
      const seedsFound = session.entries.filter((e) => e.action === ACTIONS.CURRENCY).reduce((s, e) => s + e.price, 0);
      const sellProfit = session.entries.filter((e) => e.action === ACTIONS.SELL).reduce((s, e) => s + (e.price - e.cost) * e.qty, 0);
      sessionsBody.innerHTML += `<tr>
        <td class="font-mono" style="font-size:0.75rem;color:var(--muted)">${date}</td>
        <td style="font-weight:600;color:var(--violet)">Session ${num}</td>
        <td style="text-align:right" class="font-mono">${itemsFound}</td>
        <td style="text-align:right;color:var(--amber)" class="font-mono">${Math.floor(seedsFound).toLocaleString()}</td>
        <td style="text-align:right;font-weight:600;${sellProfit >= 0 ? 'color:var(--emerald)' : 'color:var(--rose)'}" class="font-mono">${sellProfit > 0 ? '+' : ''}${Math.floor(sellProfit).toLocaleString()}</td>
      </tr>`;
    });
  }

  buildNetWorthChart();
}

// ─── Price history modal ──────────────────────────────────────────────────────
function showPriceHistory(name) {
  const modal = document.getElementById('priceHistoryModal');
  const title = document.getElementById('priceHistoryTitle');
  const statsEl = document.getElementById('priceHistoryStats');
  if (!modal || !title) return;

  const sells = audit
    .filter((e) => e.action === ACTIONS.SELL && e.name === name && ![ACTIONS.VOID, ACTIONS.REVERTED].includes(e.action))
    .sort((a, b) => a.ts - b.ts)
    .slice(-50);

  if (sells.length === 0) return;

  const prices = sells.map((s) => s.price);
  const avg = prices.reduce((a, b) => a + b, 0) / prices.length;
  const sorted = [...prices].sort((a, b) => a - b);
  const med = sorted.length % 2 ? sorted[Math.floor(sorted.length / 2)] : (sorted[sorted.length / 2 - 1] + sorted[sorted.length / 2]) / 2;

  title.textContent = name;
  statsEl.textContent = `${sells.length} sales · avg ${Math.floor(avg).toLocaleString()} · median ${Math.floor(med).toLocaleString()}`;
  modal.style.display = 'flex';

  const labels = sells.map((s) => new Date(s.ts).toLocaleDateString(undefined, { month: 'short', day: 'numeric' }));
  const canvas = document.getElementById('priceHistoryCanvas');
  if (priceHistoryChart) priceHistoryChart.destroy();
  priceHistoryChart = new Chart(canvas, {
    type: 'line',
    data: {
      labels,
      datasets: [
        { label: 'Sell Price', data: prices, borderColor: '#06b6d4', backgroundColor: 'rgba(6,182,212,0.08)', fill: true, tension: 0.3, pointRadius: 4, pointHoverRadius: 6 },
        { label: 'Median', data: Array(prices.length).fill(med), borderColor: 'rgba(245,158,11,0.5)', borderDash: [4, 4], pointRadius: 0, fill: false },
      ],
    },
    options: {
      responsive: true, maintainAspectRatio: false,
      plugins: { legend: { labels: { color: '#94a3b8', font: { size: 11 } } } },
      scales: {
        x: { ticks: { color: '#64748b', maxTicksLimit: 10 }, grid: { color: '#1e2633' } },
        y: { ticks: { color: '#64748b' }, grid: { color: '#1e2633' } },
      },
    },
  });
}

function closePriceHistory() {
  const modal = document.getElementById('priceHistoryModal');
  if (modal) modal.style.display = 'none';
  if (priceHistoryChart) { priceHistoryChart.destroy(); priceHistoryChart = null; }
}

function handleModalClick(e) {
  if (e.target === document.getElementById('priceHistoryModal')) closePriceHistory();
}

// ─── Net worth chart ──────────────────────────────────────────────────────────
function buildNetWorthChart() {
  const canvas = document.getElementById('chartCanvas');
  if (!canvas || typeof Chart === 'undefined') return;
  const valid = audit.filter((l) => ![ACTIONS.VOID, ACTIONS.REVERTED].includes(l.action));
  const points = [];
  let liquid = 0, profit = 0;
  [...valid].sort((a, b) => a.ts - b.ts).forEach((e) => {
    if (e.action === ACTIONS.INITIAL) liquid = e.price || 0;
    else if (e.action === ACTIONS.CURRENCY || e.action === ACTIONS.ADJUST) liquid += e.price || 0;
    else if (e.action === ACTIONS.PURCHASE) liquid -= (e.cost || 0) * (e.qty || 1);
    else if (e.action === ACTIONS.SELL) { liquid += (e.price || 0) * (e.qty || 1); profit += ((e.price || 0) - (e.cost || 0)) * (e.qty || 1); }
    if (e.action !== ACTIONS.SESSION_START) points.push({ ts: e.ts, liquid, profit });
  });
  const labels = points.map((p) => new Date(p.ts).toLocaleDateString(undefined, { month: 'short', day: 'numeric' }));
  if (chartInstance) chartInstance.destroy();
  chartInstance = new Chart(canvas, {
    type: 'line',
    data: {
      labels,
      datasets: [
        { label: 'Liquid', data: points.map((p) => p.liquid), borderColor: '#f59e0b', backgroundColor: 'rgba(245,158,11,0.1)', fill: true, tension: 0.3 },
        { label: 'Profit', data: points.map((p) => p.profit), borderColor: '#10b981', fill: false, tension: 0.3 },
      ],
    },
    options: {
      responsive: true, maintainAspectRatio: false,
      plugins: { legend: { labels: { color: '#94a3b8', font: { size: 11 } } } },
      scales: {
        x: { ticks: { color: '#64748b', maxTicksLimit: 10 }, grid: { color: '#1e2633' } },
        y: { ticks: { color: '#64748b' }, grid: { color: '#1e2633' } },
      },
    },
  });
}

// ─── Import / Export ──────────────────────────────────────────────────────────
function exportData() {
  const blob = new Blob([JSON.stringify({ stock, audit, liquidSeeds })], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'arc-tracker-export.json';
  a.click();
}

function importData(input) {
  const f = input.files[0];
  if (!f) return;
  const r = new FileReader();
  r.onload = (e) => {
    const d = JSON.parse(e.target.result);
    stock = d.stock || [];
    audit = d.audit || [];
    liquidSeeds = d.liquidSeeds ?? 0;
    render();
  };
  r.readAsText(f);
}

// ─── Loot textarea autocomplete ───────────────────────────────────────────────
function initTextareaAutocomplete() {
  const textarea = document.getElementById('bulkText');
  if (!textarea) return;

  const dropdown = document.createElement('div');
  Object.assign(dropdown.style, {
    position: 'fixed', zIndex: '9999',
    background: 'var(--bg-1)', border: '1px solid var(--border-bright)',
    borderRadius: '8px', maxHeight: '220px', overflowY: 'auto',
    display: 'none', boxShadow: '0 8px 24px rgba(0,0,0,0.5)',
  });
  document.body.appendChild(dropdown);

  let selectedIndex = -1;
  let currentMatches = [];

  function getCurrentLineText() {
    const val = textarea.value, pos = textarea.selectionStart;
    const lineStart = val.lastIndexOf('\n', pos - 1) + 1;
    const lineEnd = val.indexOf('\n', pos);
    const line = val.slice(lineStart, lineEnd === -1 ? undefined : lineEnd);
    return line.replace(/^\d+\s*/, '').trim();
  }

  function replaceCurrentLine(name) {
    const val = textarea.value, pos = textarea.selectionStart;
    const lineStart = val.lastIndexOf('\n', pos - 1) + 1;
    const lineEnd = val.indexOf('\n', pos);
    const line = val.slice(lineStart, lineEnd === -1 ? val.length : lineEnd);
    const numMatch = line.match(/^(\d+\s*)/);
    const prefix = numMatch ? numMatch[0] : '';
    textarea.value = val.slice(0, lineStart) + prefix + name + (lineEnd === -1 ? '' : val.slice(lineEnd));
    const newPos = lineStart + prefix.length + name.length;
    textarea.setSelectionRange(newPos, newPos);
    hideDropdown();
  }

  function updateHighlight() {
    Array.from(dropdown.children).forEach((el, i) => {
      el.style.background = i === selectedIndex ? 'var(--bg-3)' : 'transparent';
      el.style.color = i === selectedIndex ? 'var(--cyan)' : 'var(--text-dim)';
    });
  }

  function showDropdown(matches) {
    currentMatches = matches; selectedIndex = -1; dropdown.innerHTML = '';
    matches.forEach((name, i) => {
      const item = document.createElement('div');
      item.textContent = name;
      Object.assign(item.style, { padding: '8px 14px', cursor: 'pointer', fontSize: '0.8rem', fontFamily: "'JetBrains Mono', monospace", color: 'var(--text-dim)', borderBottom: '1px solid var(--border)', transition: 'background 0.1s' });
      item.addEventListener('mouseenter', () => { selectedIndex = i; updateHighlight(); });
      item.addEventListener('mousedown', (e) => { e.preventDefault(); replaceCurrentLine(name); });
      dropdown.appendChild(item);
    });
    const rect = textarea.getBoundingClientRect();
    dropdown.style.left = `${rect.left}px`;
    dropdown.style.top = `${rect.bottom + 4}px`;
    dropdown.style.width = `${rect.width}px`;
    dropdown.style.display = 'block';
  }

  function hideDropdown() { dropdown.style.display = 'none'; selectedIndex = -1; currentMatches = []; }

  textarea.addEventListener('input', () => {
    const query = getCurrentLineText();
    if (query.length < 2) { hideDropdown(); return; }
    const lower = query.toLowerCase();
    const matches = apiItems.map((i) => i.name).filter((n) => n && n.toLowerCase().includes(lower)).slice(0, 12);
    if (matches.length === 0) { hideDropdown(); return; }
    showDropdown(matches);
  });

  textarea.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') { e.preventDefault(); massIngest(); return; }
    if (dropdown.style.display === 'none') return;
    if (e.key === 'ArrowDown') { e.preventDefault(); selectedIndex = Math.min(selectedIndex + 1, currentMatches.length - 1); updateHighlight(); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); selectedIndex = Math.max(selectedIndex - 1, 0); updateHighlight(); }
    else if (e.key === 'Enter') {
      // Single match → fill immediately; multiple → require selection first
      const target = currentMatches.length === 1 ? currentMatches[0] : (selectedIndex >= 0 ? currentMatches[selectedIndex] : null);
      if (target) { e.preventDefault(); replaceCurrentLine(target); }
    }
    else if (e.key === 'Tab') { const t = selectedIndex >= 0 ? currentMatches[selectedIndex] : currentMatches[0]; if (t) { e.preventDefault(); replaceCurrentLine(t); } }
    else if (e.key === 'Escape') { hideDropdown(); }
  });

  textarea.addEventListener('blur', () => setTimeout(hideDropdown, 150));
  window.addEventListener('scroll', hideDropdown, true);
}

// ─── Init ─────────────────────────────────────────────────────────────────────
function init() {
  Object.assign(window, {
    switchTab, massIngest, buyItem, executeBarter,
    generateRandomHistory, adjustBalance, resyncMetaforge,
    exportData, importData, voidEntry, revertEntry, sellX,
    sellAll, startNewSession, showPriceHistory, closePriceHistory,
    handleModalClick, toggleCustomItems,
  });

  loadMetaforgeCache();
  initTextareaAutocomplete();

  const customToggle = document.getElementById('allowCustomItemsToggle');
  if (customToggle) customToggle.checked = allowCustomItems;

  (async () => {
    try {
      if (!apiItems || apiItems.length === 0) {
        apiItems = await fetchMetaforgeFromLocalFile();
        if (apiItems.length) {
          writeJson(STORAGE_KEYS.metaforgeCache, apiItems);
          localStorage.setItem(STORAGE_KEYS.metaforgeCacheTs, String(Date.now()));
          const el = document.getElementById('metaforgeStatus');
          if (el) el.textContent = `Synced (site data) ${new Date().toLocaleString()} (${apiItems.length})`;
        }
      }
    } catch { /* ignore */ }
    render();
  })();

  if (audit.length === 0) {
    const seed = parseFloat(prompt('Enter initial Seed Capital:', '0')) || 0;
    liquidSeeds = seed;
    audit.push({ id: genId(), ts: Date.now(), action: ACTIONS.INITIAL, name: 'Starting Capital', qty: 1, price: seed, cost: 0, source: 'SYS' });
  }
  render();
}

init();
