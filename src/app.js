/* global Chart */
'use strict';

import { ACTIONS, LOCAL_METAFORGE_ITEMS_URL, METAFORGE_URL, STORAGE_KEYS } from './constants.js';
import { readJson, readNumber, writeJson } from './storage.js';

const SOURCES = Object.freeze({
  LOOTED: 'LOOTED',
  BUY: 'BUY',
  TRADE: 'TRADE',
  SYS: 'SYS',
});

const LOCAL_METAFORGE_QUESTS_URL = './data/metaforge-quests.json';

let stock = readJson(STORAGE_KEYS.stock, []);
let audit = readJson(STORAGE_KEYS.audit, []);
let liquidSeeds = readNumber(STORAGE_KEYS.liquidSeeds, 0);
let priceCache = {};
let apiItems = [];
let tradeItems = [];
let iconMap = {};
let stackMap = {};   // name -> stackSize
let itemTypeMap = {}; // name -> item_type
let quests = [];
let questDemandMap = {};
let allowCustomItems = localStorage.getItem(STORAGE_KEYS.allowCustomItems) === 'true';
let staleThresholdDays = parseFloat(localStorage.getItem(STORAGE_KEYS.staleThresholdDays)) || 7;
let listingOutput = { metaforge: '', discord: '' };
let chartInstance = null;
let priceHistoryChart = null;

function genId() {
  return `e${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
}

// ─── Metaforge data ───────────────────────────────────────────────────────────
function buildDerivedItemData(items) {
  tradeItems = items.filter((i) => i.value > 0);
  iconMap = {}; stackMap = {}; itemTypeMap = {};
  items.forEach((i) => {
    if (i.name && i.icon) iconMap[i.name] = i.icon;
    if (i.name) {
      stackMap[i.name] = i.stat_block?.stackSize || 1;
      itemTypeMap[i.name] = i.item_type || '';
    }
  });
}

function loadMetaforgeCache() {
  try {
    const raw = localStorage.getItem(STORAGE_KEYS.metaforgeCache);
    const ts = localStorage.getItem(STORAGE_KEYS.metaforgeCacheTs);
    if (raw) {
      const data = JSON.parse(raw);
      apiItems = Array.isArray(data) ? data : data.data || [];
      buildDerivedItemData(apiItems);
      const el = document.getElementById('metaforgeStatus');
      if (el) el.textContent = ts ? `Synced ${new Date(+ts).toLocaleString()}` : 'Cached';
    }
  } catch { apiItems = []; tradeItems = []; iconMap = {}; }
}

async function fetchMetaforgeAll() {
  const out = [];
  let page = 1, hasMore = true;
  while (hasMore) {
    if (page > 200) throw new Error('Safety stop: exceeded maxPages.');
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
  if (!res.ok) throw new Error(`Local items file HTTP ${res.status}`);
  const json = await res.json();
  return Array.isArray(json) ? json : json.data || [];
}

async function fetchQuestsFromLocalFile() {
  const res = await fetch(LOCAL_METAFORGE_QUESTS_URL, { cache: 'no-store' });
  if (!res.ok) throw new Error(`Local quests file HTTP ${res.status}`);
  const json = await res.json();
  return Array.isArray(json) ? json : json.data || [];
}

function buildQuestDemandMap(questList) {
  questDemandMap = {};
  questList.forEach((q) => {
    (q.required_items || []).forEach((ri) => {
      const name = ri.item?.name;
      if (!name) return;
      if (!questDemandMap[name]) questDemandMap[name] = [];
      questDemandMap[name].push(q.name);
    });
  });
}

function formatFetchErr(e) {
  const msg = (e && (e.message || String(e))) || 'Unknown error';
  return /failed to fetch/i.test(msg) ? `${msg} (likely CORS blocked)` : msg;
}

async function resyncMetaforge() {
  const btn = document.getElementById('resyncBtn');
  if (btn) { btn.disabled = true; btn.textContent = 'Syncing...'; }
  try {
    apiItems = await fetchMetaforgeAll();
    buildDerivedItemData(apiItems);
    writeJson(STORAGE_KEYS.metaforgeCache, apiItems);
    localStorage.setItem(STORAGE_KEYS.metaforgeCacheTs, String(Date.now()));
    const el = document.getElementById('metaforgeStatus');
    if (el) el.textContent = `Synced ${new Date().toLocaleString()} (${apiItems.length} items)`;
  } catch (e) {
    const el = document.getElementById('metaforgeStatus');
    if (el) el.textContent = `Sync failed: ${formatFetchErr(e)}. Use the GitHub Action on GitHub Pages.`;
  }
  if (btn) { btn.disabled = false; btn.textContent = 'Resync API'; }
  render();
}

// ─── Item name helpers ────────────────────────────────────────────────────────
function normalizeItemName(input) {
  if (!input || typeof input !== 'string') return input;
  const t = input.trim();
  const match = apiItems.find((i) => (i.name || '').toLowerCase() === t.toLowerCase());
  return match ? match.name : t;
}

function validateItemName(raw) {
  const name = normalizeItemName(raw);
  if (allowCustomItems || apiItems.length === 0) return name;
  const known = apiItems.some((i) => (i.name || '').toLowerCase() === name.toLowerCase());
  if (!known) {
    alert(`"${name}" is not in the Metaforge item list.\n\nCheck the spelling, or enable Custom Named Items in Tools → Settings.`);
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

// ─── Age colour ───────────────────────────────────────────────────────────────
function staleColor(oldestAddedAt) {
  if (!oldestAddedAt || !staleThresholdDays) return null;
  const ratio = (Date.now() - oldestAddedAt) / (staleThresholdDays * 86400000);
  if (ratio < 0.5) return null;
  if (ratio < 0.75) return '#f59e0b';
  if (ratio < 1.0) return '#f97316';
  return '#f43f5e';
}

// ─── Tab switching ────────────────────────────────────────────────────────────
function switchTab(t) {
  document.querySelectorAll('.tab-content').forEach((e) => e.classList.remove('active'));
  document.querySelectorAll('.nav-btn, .topnav-btn').forEach((b) => b.classList.remove('active'));
  document.getElementById(`view-${t}`)?.classList.add('active');
  document.getElementById(`nav-${t}`)?.classList.add('active');
  document.getElementById(`topnav-${t}`)?.classList.add('active');
  const content = document.querySelector('.content');
  if (content) content.scrollTop = 0;
  if (t === 'analytics') renderAnalytics();
  if (t === 'comms') renderCommsTab();
  if (t === 'themes') updateThemeUI();
}

// ─── Icon helper ──────────────────────────────────────────────────────────────
function itemIcon(name, size = 28) {
  const url = iconMap[name];
  if (!url) return `<span style="display:inline-block;width:${size}px;height:${size}px;background:var(--bg-3);border-radius:4px;flex-shrink:0;"></span>`;
  return `<img src="${url}" width="${size}" height="${size}" style="border-radius:4px;object-fit:contain;background:var(--bg-3);flex-shrink:0;" loading="lazy" onerror="this.style.display='none'">`;
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
    if (!acc[k]) acc[k] = { ...item, count: 0, oldestAddedAt: item.addedAt || null };
    else if (item.addedAt && (!acc[k].oldestAddedAt || item.addedAt < acc[k].oldestAddedAt)) acc[k].oldestAddedAt = item.addedAt;
    acc[k].count++;
    return acc;
  }, {});

  const sortedGroups = Object.values(grouped).sort((a, b) => a.name.localeCompare(b.name));
  const blueprints = sortedGroups.filter((g) => apiItems.find((i) => i.name === g.name)?.item_type === 'Blueprint');
  const general = sortedGroups.filter((g) => apiItems.find((i) => i.name === g.name)?.item_type !== 'Blueprint');

  function renderGroupRow(g, i) {
    const myMedian = priceCache[g.name] || null;
    assetValuation += (myMedian ?? g.cost) * g.count;
    if (searchQuery && !g.name.toLowerCase().includes(searchQuery)) return;

    const safeId = `item-${i}`;
    const tag = g.source === SOURCES.LOOTED ? 'tag-looted' : g.source === SOURCES.TRADE ? 'tag-trade' : 'tag-buy';
    const tagLabel = g.source === SOURCES.LOOTED ? 'Looted' : g.source === SOURCES.TRADE ? 'Trade' : 'Bought';
    const demandQuests = questDemandMap[g.name];
    const questBadge = demandQuests ? `<span class="quest-badge" title="Needed for: ${demandQuests.join(', ')}">Q</span>` : '';
    const ageCol = staleColor(g.oldestAddedAt);
    const rowStyle = ageCol ? `border-left:3px solid ${ageCol};` : '';
    const ageTitle = g.oldestAddedAt ? `Held for ${Math.floor((Date.now() - g.oldestAddedAt) / 86400000)}d (oldest unit)` : '';

    invBody.innerHTML += `<tr style="${rowStyle}" ${ageTitle ? `title="${ageTitle}"` : ''}>
      <td><div style="display:flex;align-items:center;gap:8px;">${itemIcon(g.name, 28)}<span class="font-mono font-semibold">${g.name}</span>${questBadge}</div></td>
      <td><span class="tag ${tag}">${tagLabel}</span></td>
      <td class="font-mono">×${g.count}</td>
      <td class="font-mono" style="color:var(--muted);font-size:0.78rem;">${(() => {
        const ss = stackMap[g.name] || 1;
        if (ss === 1) return `${g.count} (${g.count} slot${g.count !== 1 ? 's' : ''})`;
        const full = Math.floor(g.count / ss);
        const rem = g.count % ss;
        if (full === 0) return `${g.count} (${g.count} of ${ss} for stack)`;
        if (rem === 0) return `${g.count} (${full}× stacks of ${ss})`;
        return `${g.count} (${full}× stacks of ${ss}, +${rem})`;
      })()}</td>
      <td class="font-mono" style="color:var(--muted)">${g.source === 'LOOTED' ? '<span style="color:var(--border-bright)">N/A</span>' : Math.floor(g.cost).toLocaleString()}</td>
      <td class="font-mono" style="${myMedian ? 'color:var(--cyan)' : 'color:var(--muted)'}">${myMedian ? Math.floor(myMedian).toLocaleString() : '—'}</td>
      <td style="text-align:right;white-space:nowrap;">
        <input type="number" id="q-${safeId}" value="1" min="1" max="${g.count}" style="width:52px;padding:6px;margin-right:2px;display:inline-block">
        <input type="number" id="p-${safeId}" placeholder="Price" style="width:80px;padding:6px;margin-right:4px;display:inline-block">
        <button class="btn btn-sell" onclick="sellX('${g.name.replace(/'/g, "\\'")}', '${g.source}', ${g.cost}, '${safeId}')">Sell</button>
        <button class="btn btn-ghost" style="padding:6px 10px;font-size:0.7rem;color:var(--amber)" title="Sell entire stack" onclick="sellAll('${g.name.replace(/'/g, "\\'")}', '${g.source}', ${g.cost}, '${safeId}')">All</button>
      </td>
    </tr>`;
    barterSelect.innerHTML += `<option value="${g.name}|${g.source}|${g.cost}">${g.name} [${tagLabel}] ×${g.count}</option>`;
  }

  function sectionHeader(label, count) {
    invBody.innerHTML += `<tr class="warehouse-section-header"><td colspan="6"><span>${label}</span><span style="color:var(--muted);font-weight:400;margin-left:0.5rem;">${count} item${count !== 1 ? 's' : ''}</span></td></tr>`;
  }

  if (general.length > 0) {
    sectionHeader('General', general.length);
    general.forEach((g, i) => renderGroupRow(g, i));
  }
  if (blueprints.length > 0) {
    sectionHeader('Blueprints', blueprints.length);
    blueprints.forEach((g, i) => renderGroupRow(g, general.length + i));
  }

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
    const actClr = profitDelta > 0 ? 'color:var(--emerald)' : profitDelta < 0 ? 'color:var(--rose)' : isInitial ? 'color:var(--cyan)' : isExcluded ? 'color:var(--muted)' : isBarter ? 'color:#a78bfa' : '';

    auditBody.insertAdjacentHTML('beforeend',
      `<tr style="${isExcluded ? 'opacity:0.5' : ''}">
        <td class="font-mono" style="font-size:0.75rem;color:var(--muted)">${time}</td>
        <td style="font-weight:600;font-size:0.75rem;${actClr}">${entry.action}</td>
        <td style="${isExcluded ? 'text-decoration:line-through' : ''}"><div style="display:flex;align-items:center;gap:6px;">${itemIcon(entry.name, 18)}<span>${entry.name}</span></div></td>
        <td class="font-mono" style="color:var(--muted)">${isCurrency || isInitial ? '—' : '×' + entry.qty}</td>
        <td style="text-align:right;font-weight:600;${profitDelta >= 0 ? 'color:var(--amber)' : 'color:var(--rose)'}">${profitDelta !== 0 ? (profitDelta > 0 ? '+' : '') + Math.floor(profitDelta).toLocaleString() : isInitial || isBarter ? Math.floor(entry.price).toLocaleString() : '—'}</td>
        <td style="text-align:right">${!isExcluded && entry.action !== ACTIONS.INITIAL
          ? `<button class="btn btn-ghost" style="padding:2px 6px;font-size:0.65rem" onclick="voidEntry(${idx})">Void</button><button class="btn btn-ghost" style="padding:2px 6px;font-size:0.65rem" onclick="revertEntry(${idx})">Revert</button>`
          : isReverted ? '<span style="font-size:0.7rem;color:var(--muted)">Reverted</span>' : ''}</td>
      </tr>`
    );
  }

  const allNames = [...new Set([...stock.map((i) => i.name), ...audit.map((i) => i.name), ...apiItems.map((i) => i.name)])]
    .filter(Boolean).sort();
  allNames.forEach((n) => { dataList.innerHTML += `<option value="${n}">`; });

  document.getElementById('liquidDisplay').textContent = Math.floor(liquidSeeds).toLocaleString();
  document.getElementById('assetValuation').textContent = Math.floor(assetValuation).toLocaleString();
  document.getElementById('netWorth').textContent = '~' + Math.floor(liquidSeeds + assetValuation).toLocaleString();
  document.getElementById('totalProfit').textContent = Math.floor(totalProfit).toLocaleString();
  document.getElementById('invCount').textContent = stock.length;

  const randBtn = document.getElementById('randomHistoryBtn');
  if (randBtn) {
    const hasItems = tradeItems.length > 0;
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
  audit.push({ id: genId(), ts: Date.now(), action: ACTIONS.SESSION_START, name: 'Session Start', qty: 1, price: 0, cost: 0, source: SOURCES.SYS });
  render();
}

// ─── Inventory actions ────────────────────────────────────────────────────────
function massIngest() {
  const raw = (document.getElementById('bulkText').value || '').trim();
  if (!raw) return;

  const lines = raw.split('\n').filter((l) => l.trim());
  const parsed = [];

  for (const line of lines) {
    const nums = line.match(/\d+/);
    const rawName = line.replace(/\d+/, '').trim();
    if (!rawName) continue;
    const qty = nums ? parseInt(nums[0], 10) : 1;
    const lower = rawName.toLowerCase();

    // Seeds variants — always valid
    if (lower === 'assorted seeds' || lower === 'raw seeds' || lower === 'seeds') {
      parsed.push({ type: 'currency', rawName, qty });
      continue;
    }

    // Validate against API list if custom items are off
    const text = validateItemName(rawName);
    if (!text) {
      // validateItemName already showed an alert with the item name — stop here
      return;
    }
    parsed.push({ type: 'item', text, qty });
  }

  // All lines passed — commit everything
  const now = Date.now();
  for (const entry of parsed) {
    if (entry.type === 'currency') {
      liquidSeeds += entry.qty;
      audit.push({ id: genId(), ts: now, action: ACTIONS.CURRENCY, name: entry.rawName, qty: 1, price: entry.qty, cost: 0, source: SOURCES.LOOTED, revertData: { deltaLiquid: -entry.qty } });
    } else {
      for (let i = 0; i < entry.qty; i++) stock.push({ name: entry.text, cost: 0, source: SOURCES.LOOTED, addedAt: now });
      audit.push({ id: genId(), ts: now, action: ACTIONS.RECOVERY, name: entry.text, qty: entry.qty, price: 0, cost: 0, source: SOURCES.LOOTED, revertData: { removeStock: [{ name: entry.text, source: SOURCES.LOOTED, cost: 0, qty: entry.qty }] } });
    }
  }

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
  const now = Date.now();
  for (let i = 0; i < qty; i++) stock.push({ name, cost: costPer, source: SOURCES.BUY, addedAt: now });
  audit.push({ id: genId(), ts: now, action: ACTIONS.PURCHASE, name, qty, price: costPer, cost: costPer, source: SOURCES.BUY, revertData: { deltaLiquid: total, removeStock: { name, source: SOURCES.BUY, cost: costPer, qty } } });
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
  const costPer = Math.floor(totalVal / toQty);

  let removed = 0;
  for (let i = stock.length - 1; i >= 0 && removed < fromQty; i--) {
    if (stock[i].name === oldName && stock[i].source === oldSrc && Math.floor(stock[i].cost) === Math.floor(oldCost)) { stock.splice(i, 1); removed++; }
  }

  const now = Date.now();
  for (let i = 0; i < toQty; i++) stock.push({ name: toNorm, cost: costPer, source: SOURCES.TRADE, addedAt: now });
  const addBack = [];
  for (let i = 0; i < fromQty; i++) addBack.push({ name: oldName, source: oldSrc, cost: parseFloat(oldCost) });

  audit.push({
    id: genId(), ts: now, action: ACTIONS.BARTER,
    name: `${fromQty}× ${oldName} → ${toQty}× ${toNorm}`,
    qty: toQty, price: totalVal, cost: totalVal, source: SOURCES.TRADE,
    revertData: { removeStock: { name: toNorm, source: SOURCES.TRADE, cost: costPer, qty: toQty }, addStock: addBack },
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
  audit.push({ id: genId(), ts: Date.now(), action: ACTIONS.ADJUST, name: 'Manual Correction', qty: 1, price: amt, cost: 0, source: SOURCES.SYS, revertData: { deltaLiquid: -amt } });
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
          if (stock[i].name === name && stock[i].source === (source || SOURCES.TRADE) && Math.floor(stock[i].cost) === Math.floor(cost || 0)) { stock.splice(i, 1); removed++; }
        }
      });
    }
  } else if (e.action === ACTIONS.BARTER && e.barterFrom && e.barterTo) {
    const from = e.barterFrom, to = e.barterTo;
    const costPer = e.cost / to.qty;
    let removed = 0;
    for (let i = stock.length - 1; i >= 0 && removed < to.qty; i--) {
      if (stock[i].name === to.name && stock[i].source === SOURCES.TRADE && Math.floor(stock[i].cost) === Math.floor(costPer)) { stock.splice(i, 1); removed++; }
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
  const mergeBlock = document.getElementById('customMergeBlock');
  if (mergeBlock) mergeBlock.style.display = checkbox.checked ? '' : 'none';
}

function mergeCustomItems() {
  const from = (document.getElementById('mergeFromInput').value || '').trim();
  const to = (document.getElementById('mergeToInput').value || '').trim();
  if (!from || !to || !confirm(`Rename all instances of "${from}" to "${to}"?`)) return;
  stock = stock.map((i) => i.name === from ? { ...i, name: to } : i);
  audit = audit.map((a) => {
    if (a.name === from) return { ...a, name: to };
    if (a.action === ACTIONS.BARTER && a.name?.includes('→')) {
      return { ...a, name: a.name.replace(new RegExp(`\\b${from.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'g'), to) };
    }
    return a;
  });
  document.getElementById('mergeFromInput').value = '';
  document.getElementById('mergeToInput').value = '';
  render();
}

function addStartingStock() {
  const raw = (document.getElementById('startingStockText').value || '').trim();
  if (!raw) return;
  let added = 0;
  raw.split('\n').forEach((line) => {
    const nums = line.match(/\d+/);
    const rawName = line.replace(/\d+/, '').trim();
    if (!rawName) return;
    const qty = nums ? parseInt(nums[0], 10) : 1;
    const text = validateItemName(rawName);
    if (!text) return;
    const now = Date.now();
    for (let i = 0; i < qty; i++) stock.push({ name: text, cost: 0, source: SOURCES.LOOTED, addedAt: now });
    audit.push({ id: genId(), ts: now, action: ACTIONS.STOCK_INIT, name: text, qty, price: 0, cost: 0, source: SOURCES.LOOTED, revertData: { removeStock: [{ name: text, source: SOURCES.LOOTED, cost: 0, qty }] } });
    added += qty;
  });
  if (added > 0) { document.getElementById('startingStockText').value = ''; render(); }
}

function setStaleThreshold() {
  const val = parseFloat(document.getElementById('staleThresholdInput').value);
  if (isNaN(val) || val <= 0) return;
  staleThresholdDays = val;
  localStorage.setItem(STORAGE_KEYS.staleThresholdDays, String(val));
  render();
}

// ─── Random history ───────────────────────────────────────────────────────────
function generateRandomHistory() {
  if (tradeItems.length === 0) return;
  if (!confirm('Add a random raid session to existing history?')) return;

  function pick(arr, n) {
    const a = [...arr];
    for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; }
    return a.slice(0, n);
  }
  function randInt(min, max) { return min + Math.floor(Math.random() * (max - min + 1)); }
  function weighted(options) { // [{val, weight}]
    const total = options.reduce((s, o) => s + o.weight, 0);
    let r = Math.random() * total;
    for (const o of options) { r -= o.weight; if (r <= 0) return o.val; }
    return options[options.length - 1].val;
  }

  function realisticSellPrice(item) {
    const isBlueprint = item.item_type === 'Blueprint';
    if (isBlueprint) return randInt(1000, 2000);
    // ~10% chance of low-value junk (1-15 seeds, usually high qty)
    if (Math.random() < 0.10) return randInt(1, 15);
    // Otherwise 50-150 seeds with slight variation
    const base = randInt(50, 150);
    return Math.round(base * (0.85 + Math.random() * 0.3));
  }

  function realisticBuyPrice(item) {
    const isBlueprint = item.item_type === 'Blueprint';
    if (isBlueprint) return randInt(800, 1800);
    if (Math.random() < 0.10) return randInt(5, 20);
    return randInt(40, 130);
  }

  function realisticLootQty(item) {
    const isBlueprint = item.item_type === 'Blueprint';
    if (isBlueprint) return 1;
    // Junk items come in bigger stacks
    const price = realisticSellPrice(item);
    if (price <= 15) return randInt(3, 12);
    return randInt(1, 3);
  }

  // Split items into blueprints and general
  const blueprints = tradeItems.filter((i) => i.item_type === 'Blueprint');
  const general = tradeItems.filter((i) => i.item_type !== 'Blueprint');

  const now = Date.now();
  // Offset from most recent audit entry, or now minus a few days
  const lastTs = audit.length ? Math.max(...audit.map((a) => a.ts)) : now - 7 * 86400000;
  const sessionStart = lastTs + randInt(3600000, 28800000); // 1-8 hours after last entry
  const ts = (offset) => sessionStart + offset * randInt(60000, 600000); // minutes apart

  // Session start marker
  audit.push({ id: genId(), ts: sessionStart, action: ACTIONS.SESSION_START, name: 'Session Start', qty: 1, price: 0, cost: 0, source: SOURCES.SYS });

  // Pick loot: 2-5 general items, maybe 1 blueprint (25% chance)
  const lootGeneral = pick(general, randInt(2, 5));
  const lootBlueprint = blueprints.length > 0 && Math.random() < 0.25 ? pick(blueprints, 1) : [];
  const lootPool = [...lootGeneral, ...lootBlueprint];

  let step = 1;
  lootPool.forEach((item) => {
    const qty = realisticLootQty(item);
    const t = ts(step++);
    for (let i = 0; i < qty; i++) stock.push({ name: item.name, cost: 0, source: SOURCES.LOOTED, addedAt: t });
    audit.push({ id: genId(), ts: t, action: ACTIONS.RECOVERY, name: item.name, qty, price: 0, cost: 0, source: SOURCES.LOOTED, revertData: { removeStock: [{ name: item.name, source: SOURCES.LOOTED, cost: 0, qty }] } });
  });

  // Random seeds found (50-400, weighted toward lower)
  const seedsFound = weighted([
    { val: randInt(10, 30), weight: 5 },
    { val: randInt(30, 60), weight: 3 },
    { val: randInt(60, 120), weight: 1 },
  ]);
  if (Math.random() < 0.7) { // not every raid has seeds
    liquidSeeds += seedsFound;
    audit.push({ id: genId(), ts: ts(step++), action: ACTIONS.CURRENCY, name: 'Assorted Seeds', qty: 1, price: seedsFound, cost: 0, source: SOURCES.LOOTED, revertData: { deltaLiquid: -seedsFound } });
  }

  // Ensure there's some liquid to work with
  if (audit.filter((a) => a.action !== ACTIONS.SESSION_START).length === 0) {
    liquidSeeds = randInt(300, 1200);
    audit.unshift({ id: genId(), ts: sessionStart - 1000, action: ACTIONS.INITIAL, name: 'Starting Capital', qty: 1, price: liquidSeeds, cost: 0, source: SOURCES.SYS });
  }

  // Always buy something — heavily weighted toward blueprints (70%)
  {
    const useBlueprintBuy = blueprints.length > 0 && Math.random() < 0.70;
    const buyPool = useBlueprintBuy ? blueprints : general.filter((i) => !lootPool.includes(i));
    if (buyPool.length > 0) {
      const buyItem = pick(buyPool, 1)[0];
      const bQty = useBlueprintBuy ? 1 : randInt(1, 2);
      const bCost = realisticBuyPrice(buyItem);
      const total = bCost * bQty;
      if (liquidSeeds < total) liquidSeeds += total;
      liquidSeeds -= total;
      const t = ts(step++);
      for (let i = 0; i < bQty; i++) stock.push({ name: buyItem.name, cost: bCost, source: SOURCES.BUY, addedAt: t });
      audit.push({ id: genId(), ts: t, action: ACTIONS.PURCHASE, name: buyItem.name, qty: bQty, price: bCost, cost: bCost, source: SOURCES.BUY, revertData: { deltaLiquid: total, removeStock: { name: buyItem.name, source: SOURCES.BUY, cost: bCost, qty: bQty } } });
    }
  }

  // Always sell at least one item from stock this session
  const sellable = stock.filter((s) => s.source === SOURCES.LOOTED);
  const sellCount = Math.random() < 0.4 ? 2 : 1; // 40% chance of two sells
  for (let s = 0; s < sellCount && sellable.length > 0; s++) {
    const idx = Math.floor(Math.random() * sellable.length);
    const sellItem = sellable.splice(idx, 1)[0]; // avoid selling same item twice
    const maxQty = stock.filter((st) => st.name === sellItem.name && st.source === SOURCES.LOOTED).length;
    if (maxQty === 0) continue;
    const sellQty = randInt(1, Math.min(maxQty, 3));
    const sellPrice = realisticSellPrice(tradeItems.find((i) => i.name === sellItem.name) || { item_type: '' });
    let removed = 0;
    for (let i = stock.length - 1; i >= 0 && removed < sellQty; i--) {
      if (stock[i].name === sellItem.name && stock[i].source === SOURCES.LOOTED) { stock.splice(i, 1); removed++; }
    }
    liquidSeeds += sellPrice * sellQty;
    const addBack = Array.from({ length: sellQty }, () => ({ name: sellItem.name, source: SOURCES.LOOTED, cost: 0 }));
    audit.push({ id: genId(), ts: ts(step++), action: ACTIONS.SELL, name: sellItem.name, qty: sellQty, price: sellPrice, cost: 0, source: SOURCES.LOOTED, revertData: { deltaLiquid: -(sellPrice * sellQty), addStock: addBack } });
  }

  render();
}

// ─── Analytics ────────────────────────────────────────────────────────────────
function renderAnalytics() {
  const flipBody = document.getElementById('topFlipBody');
  const lootBody = document.getElementById('topLootBody');
  const perLootBody = document.getElementById('perItemLootBody');
  const perBuyBody = document.getElementById('perItemBuyBody');
  const sessionsBody = document.getElementById('sessionsBody');
  if (!flipBody || !lootBody || !perLootBody || !perBuyBody || !sessionsBody) return;

  flipBody.innerHTML = ''; lootBody.innerHTML = '';
  perLootBody.innerHTML = ''; perBuyBody.innerHTML = '';
  sessionsBody.innerHTML = '';

  const valid = audit.filter((l) => ![ACTIONS.VOID, ACTIONS.REVERTED].includes(l.action));

  const stats = valid.reduce((acc, l) => {
    if (l.action !== ACTIONS.SELL) return acc;
    if (!acc[l.name]) acc[l.name] = { profit: 0, qty: 0, revenue: 0, costBasis: 0, isLooted: l.source === SOURCES.LOOTED };
    acc[l.name].profit += (l.price - l.cost) * l.qty;
    acc[l.name].qty += l.qty;
    acc[l.name].revenue += l.price * l.qty;
    acc[l.name].costBasis += l.cost * l.qty;
    return acc;
  }, {});

  // Top profit summaries
  Object.entries(stats).sort((a, b) => b[1].profit - a[1].profit).forEach(([name, s]) => {
    const icon = itemIcon(name, 20);
    const row = `<tr><td><div style="display:flex;align-items:center;gap:6px;">${icon}<span>${name}</span></div></td><td style="text-align:right;color:var(--emerald);font-weight:600">+${Math.floor(s.profit).toLocaleString()}</td></tr>`;
    if (s.isLooted) lootBody.innerHTML += row; else flipBody.innerHTML += row;
  });

  // Per-item stats table builder
  function buildPerItemRows(entries, tbody) {
    if (entries.length === 0) {
      tbody.innerHTML = `<tr><td colspan="7" style="text-align:center;color:var(--muted);padding:1.5rem;font-size:0.85rem;">No sales recorded yet</td></tr>`;
      return;
    }
    entries.forEach(([name, s]) => {
      const avgP = s.qty ? s.revenue / s.qty : 0;
      const avgC = s.qty ? s.costBasis / s.qty : 0;
      const roi = s.costBasis > 0 ? `${((s.profit / s.costBasis) * 100).toFixed(0)}%` : '—';
      const roiStyle = s.costBasis > 0 ? (s.profit >= 0 ? 'color:var(--emerald)' : 'color:var(--rose)') : 'color:var(--muted)';
      const safeName = name.replace(/'/g, "\\'");
      tbody.innerHTML += `<tr>
        <td style="cursor:pointer" onclick="showPriceHistory('${safeName}')"><div style="display:flex;align-items:center;gap:6px;">${itemIcon(name, 20)}<span style="color:var(--cyan);text-decoration:underline dotted;">${name}</span></div></td>
        <td style="text-align:right">${s.qty}</td>
        <td style="text-align:right" class="font-mono">${Math.floor(s.revenue).toLocaleString()}</td>
        <td style="text-align:right" class="font-mono">${Math.floor(avgP).toLocaleString()}</td>
        <td style="text-align:right;color:var(--muted)" class="font-mono">${Math.floor(avgC).toLocaleString()}</td>
        <td style="text-align:right;color:var(--emerald);font-weight:600">+${Math.floor(s.profit).toLocaleString()}</td>
        <td style="text-align:right;${roiStyle}" class="font-mono">${roi}</td>
      </tr>`;
    });
  }

  const sorted = Object.entries(stats).sort((a, b) => b[1].profit - a[1].profit);
  buildPerItemRows(sorted.filter(([, s]) => s.isLooted), perLootBody);
  buildPerItemRows(sorted.filter(([, s]) => !s.isLooted), perBuyBody);

  // Session history
  const sortedAudit = [...valid].sort((a, b) => a.ts - b.ts);
  const sessions = [];
  let current = null;
  sortedAudit.forEach((e) => {
    if (e.action === ACTIONS.SESSION_START) { if (current) sessions.push(current); current = { startTs: e.ts, entries: [] }; }
    else if (current) current.entries.push(e);
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

  const sells = audit.filter((e) => e.action === ACTIONS.SELL && e.name === name && ![ACTIONS.VOID, ACTIONS.REVERTED].includes(e.action)).sort((a, b) => a.ts - b.ts).slice(-50);
  if (sells.length === 0) return;

  const prices = sells.map((s) => s.price);
  const avg = prices.reduce((a, b) => a + b, 0) / prices.length;
  const sortedP = [...prices].sort((a, b) => a - b);
  const med = sortedP.length % 2 ? sortedP[Math.floor(sortedP.length / 2)] : (sortedP[sortedP.length / 2 - 1] + sortedP[sortedP.length / 2]) / 2;

  const iconHtml = iconMap[name] ? `<img src="${iconMap[name]}" width="28" height="28" style="border-radius:4px;object-fit:contain;background:var(--bg-3);margin-right:8px;vertical-align:middle;" loading="lazy">` : '';
  title.innerHTML = `${iconHtml}${name}`;
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
    options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { labels: { color: '#94a3b8', font: { size: 11 } } } }, scales: { x: { ticks: { color: '#64748b', maxTicksLimit: 10 }, grid: { color: '#1e2633' } }, y: { ticks: { color: '#64748b' }, grid: { color: '#1e2633' } } } },
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
    data: { labels, datasets: [{ label: 'Liquid', data: points.map((p) => p.liquid), borderColor: '#f59e0b', backgroundColor: 'rgba(245,158,11,0.1)', fill: true, tension: 0.3 }, { label: 'Profit', data: points.map((p) => p.profit), borderColor: '#10b981', fill: false, tension: 0.3 }] },
    options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { labels: { color: '#94a3b8', font: { size: 11 } } } }, scales: { x: { ticks: { color: '#64748b', maxTicksLimit: 10 }, grid: { color: '#1e2633' } }, y: { ticks: { color: '#64748b' }, grid: { color: '#1e2633' } } } },
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

// ─── Shared autocomplete for regular text inputs (buyName, tradeTo) ───────────
function initInputAutocomplete(inputId) {
  const input = document.getElementById(inputId);
  if (!input) return;

  const dropdown = document.createElement('div');
  Object.assign(dropdown.style, {
    position: 'fixed', zIndex: '9999',
    background: 'var(--bg-1)', border: '1px solid var(--border-bright)',
    borderRadius: '8px', maxHeight: '260px', overflowY: 'auto',
    display: 'none', boxShadow: '0 8px 24px rgba(0,0,0,0.5)',
  });
  document.body.appendChild(dropdown);

  let selectedIndex = -1, currentMatches = [];

  function updateHighlight() {
    Array.from(dropdown.children).forEach((el, i) => { el.style.background = i === selectedIndex ? 'var(--bg-3)' : 'transparent'; });
  }

  function showDropdown(matches) {
    currentMatches = matches; selectedIndex = -1; dropdown.innerHTML = '';
    matches.forEach((item, i) => {
      const el = document.createElement('div');
      Object.assign(el.style, { padding: '7px 12px', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: '8px', borderBottom: '1px solid var(--border)', transition: 'background 0.1s' });

      if (iconMap[item.name]) {
        const img = document.createElement('img');
        img.src = iconMap[item.name]; img.width = 22; img.height = 22;
        Object.assign(img.style, { borderRadius: '3px', objectFit: 'contain', background: 'var(--bg-3)', flexShrink: '0' });
        img.loading = 'lazy';
        el.appendChild(img);
      }

      const nameSpan = document.createElement('span');
      nameSpan.textContent = item.name;
      Object.assign(nameSpan.style, { fontSize: '0.8rem', fontFamily: "'JetBrains Mono', monospace", color: 'var(--text-dim)', flex: '1' });
      el.appendChild(nameSpan);

      if (questDemandMap[item.name]) {
        const qBadge = document.createElement('span');
        qBadge.textContent = 'Q';
        Object.assign(qBadge.style, { fontSize: '0.6rem', fontWeight: '700', background: 'rgba(245,158,11,0.2)', color: 'var(--amber)', border: '1px solid rgba(245,158,11,0.4)', borderRadius: '3px', padding: '1px 4px' });
        el.appendChild(qBadge);
      }

      el.addEventListener('mouseenter', () => { selectedIndex = i; updateHighlight(); });
      el.addEventListener('mousedown', (e) => { e.preventDefault(); input.value = item.name; hideDropdown(); });
      dropdown.appendChild(el);
    });

    const rect = input.getBoundingClientRect();
    dropdown.style.left = `${rect.left}px`;
    dropdown.style.top = `${rect.bottom + 4}px`;
    dropdown.style.width = `${rect.width}px`;
    dropdown.style.display = 'block';
  }

  function hideDropdown() { dropdown.style.display = 'none'; selectedIndex = -1; currentMatches = []; }

  input.addEventListener('input', () => {
    const query = (input.value || '').trim();
    if (query.length < 2) { hideDropdown(); return; }
    const lower = query.toLowerCase();
    const matches = tradeItems.filter((i) => i.name && i.name.toLowerCase().includes(lower)).slice(0, 12);
    if (matches.length === 0) { hideDropdown(); return; }
    showDropdown(matches);
  });

  input.addEventListener('keydown', (e) => {
    if (dropdown.style.display === 'none') return;
    if (e.key === 'ArrowDown') { e.preventDefault(); selectedIndex = Math.min(selectedIndex + 1, currentMatches.length - 1); updateHighlight(); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); selectedIndex = Math.max(selectedIndex - 1, 0); updateHighlight(); }
    else if (e.key === 'Enter') {
      const t = currentMatches.length === 1 ? currentMatches[0] : (selectedIndex >= 0 ? currentMatches[selectedIndex] : null);
      if (t) { e.preventDefault(); input.value = t.name; hideDropdown(); }
    }
    else if (e.key === 'Tab') { const t = selectedIndex >= 0 ? currentMatches[selectedIndex] : currentMatches[0]; if (t) { e.preventDefault(); input.value = t.name; hideDropdown(); } }
    else if (e.key === 'Escape') { hideDropdown(); }
  });

  input.addEventListener('blur', () => setTimeout(hideDropdown, 150));
  window.addEventListener('scroll', hideDropdown, true);
}
function initTextareaAutocomplete() {
  const textarea = document.getElementById('bulkText');
  if (!textarea) return;

  const dropdown = document.createElement('div');
  Object.assign(dropdown.style, { position: 'fixed', zIndex: '9999', background: 'var(--bg-1)', border: '1px solid var(--border-bright)', borderRadius: '8px', maxHeight: '260px', overflowY: 'auto', display: 'none', boxShadow: '0 8px 24px rgba(0,0,0,0.5)' });
  document.body.appendChild(dropdown);

  let selectedIndex = -1, currentMatches = [];

  function getCurrentLineText() {
    const val = textarea.value, pos = textarea.selectionStart;
    const lineStart = val.lastIndexOf('\n', pos - 1) + 1;
    const lineEnd = val.indexOf('\n', pos);
    return val.slice(lineStart, lineEnd === -1 ? undefined : lineEnd).replace(/^\d+\s*/, '').trim();
  }

  function replaceCurrentLine(name) {
    const val = textarea.value, pos = textarea.selectionStart;
    const lineStart = val.lastIndexOf('\n', pos - 1) + 1;
    const lineEnd = val.indexOf('\n', pos);
    const line = val.slice(lineStart, lineEnd === -1 ? val.length : lineEnd);
    const prefix = (line.match(/^(\d+\s*)/) || [''])[0];
    textarea.value = val.slice(0, lineStart) + prefix + name + (lineEnd === -1 ? '' : val.slice(lineEnd));
    const newPos = lineStart + prefix.length + name.length;
    textarea.setSelectionRange(newPos, newPos);
    hideDropdown();
  }

  function updateHighlight() {
    Array.from(dropdown.children).forEach((el, i) => { el.style.background = i === selectedIndex ? 'var(--bg-3)' : 'transparent'; });
  }

  function showDropdown(matches) {
    currentMatches = matches; selectedIndex = -1; dropdown.innerHTML = '';
    matches.forEach((item, i) => {
      const el = document.createElement('div');
      Object.assign(el.style, { padding: '7px 12px', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: '8px', borderBottom: '1px solid var(--border)', transition: 'background 0.1s' });
      if (iconMap[item.name]) {
        const img = document.createElement('img');
        img.src = iconMap[item.name]; img.width = 22; img.height = 22;
        Object.assign(img.style, { borderRadius: '3px', objectFit: 'contain', background: 'var(--bg-3)', flexShrink: '0' });
        img.loading = 'lazy';
        el.appendChild(img);
      }
      const nameSpan = document.createElement('span');
      nameSpan.textContent = item.name;
      Object.assign(nameSpan.style, { fontSize: '0.8rem', fontFamily: "'JetBrains Mono', monospace", color: 'var(--text-dim)', flex: '1' });
      el.appendChild(nameSpan);
      if (questDemandMap[item.name]) {
        const qBadge = document.createElement('span');
        qBadge.textContent = 'Q';
        Object.assign(qBadge.style, { fontSize: '0.6rem', fontWeight: '700', background: 'rgba(245,158,11,0.2)', color: 'var(--amber)', border: '1px solid rgba(245,158,11,0.4)', borderRadius: '3px', padding: '1px 4px' });
        el.appendChild(qBadge);
      }
      el.addEventListener('mouseenter', () => { selectedIndex = i; updateHighlight(); });
      el.addEventListener('mousedown', (e) => { e.preventDefault(); replaceCurrentLine(item.name); });
      dropdown.appendChild(el);
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
    const matches = tradeItems.filter((i) => i.name && i.name.toLowerCase().includes(lower)).slice(0, 12);
    if (matches.length === 0) { hideDropdown(); return; }
    showDropdown(matches);
  });

  textarea.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') { e.preventDefault(); massIngest(); return; }
    if (dropdown.style.display === 'none') return;
    if (e.key === 'ArrowDown') { e.preventDefault(); selectedIndex = Math.min(selectedIndex + 1, currentMatches.length - 1); updateHighlight(); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); selectedIndex = Math.max(selectedIndex - 1, 0); updateHighlight(); }
    else if (e.key === 'Enter') { const t = currentMatches.length === 1 ? currentMatches[0] : (selectedIndex >= 0 ? currentMatches[selectedIndex] : null); if (t) { e.preventDefault(); replaceCurrentLine(t.name); } }
    else if (e.key === 'Tab') { const t = selectedIndex >= 0 ? currentMatches[selectedIndex] : currentMatches[0]; if (t) { e.preventDefault(); replaceCurrentLine(t.name); } }
    else if (e.key === 'Escape') { hideDropdown(); }
  });

  textarea.addEventListener('blur', () => setTimeout(hideDropdown, 150));
  window.addEventListener('scroll', hideDropdown, true);
}

// ─── Comms / Listing generator ────────────────────────────────────────────────
const P = {
  openers: [
    '📦 Clearing out some stock — first come, first served',
    '🛒 Got gear up for grabs, check it out',
    '💼 Moving inventory, looking for buyers',
    '📡 Broadcast open — items available',
    '⚡ Hot stock, ready to move',
    '🗃️ Stash cleanout — making room',
    '🎯 Got what you need',
    '📻 Uplink open — selling the following',
    '🧹 Inventory clearance in progress',
    '💰 Offloading some loot — make it worth your while',
    '🔔 Selling up — decent stuff available',
    '🪙 Seeds accepted, in-raid drop arranged',
    '📬 Open for trades — gear ready to move',
    '🎒 Post-raid surplus — up for grabs',
    '🌐 Speranza logistics broadcast: items available',
  ],
  singleOpeners: [
    '📦 Got a {item} up for trade',
    '🎯 Selling: {item} — decent price',
    '💼 {item} available, hit the trade button',
    '⚡ {item} ready to move, serious offers only',
    '📡 Offering up a {item}',
    '🔔 {item} for sale — arrange in-raid',
    '🪙 {item} — seeds only, in-raid drop',
    '🎒 Fresh loot: {item} up for grabs',
  ],
  connectors: [
    'Use the trade button to arrange.',
    'Arrange via trade UI.',
    'Hit me up through the trade system.',
    'In-raid meetup, your zone or mine.',
    'Ready to drop when you are.',
    'Fast and clean, no fuss.',
    'Serious buyers only.',
    'First to respond gets priority.',
    'Drop in-raid, seeds up front.',
    'Message via trade UI to lock it in.',
    'Contact through Metaforge, sort it quick.',
    'Trade request in the app.',
  ],
  closers: [
    '🤙 Reach out via the trade interface.',
    '📩 Trade button for contact.',
    '🔗 Contact through Metaforge trade UI.',
    '✌️ Trade request in the app, let\'s deal.',
    '📬 Message via trade system to arrange.',
    '🤝 Trade UI, sort it out.',
    '⚡ Quick to respond, quicker to trade.',
    '🎯 Use trade button — let\'s get this done.',
  ],
  quickTrades: [
    '⚡ Trading only right now — not raiding, so no long wait.',
    '🟢 Available to trade now — not in a match, quick turnaround.',
    '⏱️ Online and trading only — won\'t keep you waiting.',
    '🎯 Not raiding right now — trades get sorted fast.',
    '✅ Available immediately — just pending trades ahead of you.',
    '⚡ Sitting in base — trades processed quickly.',
  ],
  acceptOffers: [
    '🔄 Open to offers — seeds or item swap.',
    '💱 Prices flexible, item swaps welcome.',
    '🤝 Open to negotiation — seeds or barter.',
    '💬 Make an offer — open to discussion.',
    '🔄 Flexible on price and open to swaps.',
    '💱 Got something to trade? Show me — or make a price offer.',
  ],
  bulkDiscount: [
    '📦 Buy more, save more — {pct}% off on bulk.',
    '🛒 {pct}% discount for bulk orders.',
    '💰 Bundle deal: {pct}% off when buying multiple.',
    '📉 Take more, pay less — {pct}% bulk discount.',
    '🛍️ Stacking? {pct}% off the total for bulk buyers.',
    '💸 Bulk deal: {pct}% off if you\'re buying multiple items.',
  ],
  lootedNote: [
    '✅ All items freshly looted.',
    '🎒 Everything listed is straight from raids.',
    '✅ Looted personally — no market sourced stock.',
    '🏆 All items looted, verified fresh.',
  ],
  negotiable: [
    '💬 Prices are open to discussion.',
    '🤝 Willing to negotiate — make an offer.',
    '💬 Flexible on price, talk to me.',
    '📊 Numbers aren\'t set in stone.',
    '💬 Open to reasonable offers.',
    '🤝 Price is a starting point, not a ceiling.',
  ],
};

function rnd(arr) { return arr[Math.floor(Math.random() * arr.length)]; }

function renderCommsTab() {
  const tbody = document.getElementById('commsItemTable');
  if (!tbody) return;
  tbody.innerHTML = '';

  const grouped = stock.reduce((acc, item) => {
    const k = `${item.name}-${item.source}-${Math.floor(item.cost)}`;
    if (!acc[k]) acc[k] = { ...item, count: 0 };
    acc[k].count++;
    return acc;
  }, {});

  Object.values(grouped).sort((a, b) => a.name.localeCompare(b.name)).forEach((g, i) => {
    const safeId = `comms-${i}`;
    const median = priceCache[g.name] ? Math.floor(priceCache[g.name]) : '';
    const icon = iconMap[g.name] ? `<img src="${iconMap[g.name]}" width="20" height="20" style="border-radius:3px;object-fit:contain;background:var(--bg-3);vertical-align:middle;margin-right:6px;" loading="lazy">` : '';
    const tagLabel = g.source === SOURCES.LOOTED ? 'Looted' : g.source === SOURCES.TRADE ? 'Trade' : 'Bought';
    const tagClass = g.source === SOURCES.LOOTED ? 'tag-looted' : g.source === SOURCES.TRADE ? 'tag-trade' : 'tag-buy';
    tbody.innerHTML += `<tr>
      <td style="padding:8px 12px;"><input type="checkbox" class="comms-check" data-name="${g.name.replace(/"/g, '&quot;')}" data-source="${g.source}" data-count="${g.count}" data-id="${safeId}" style="width:16px;height:16px;accent-color:var(--cyan);cursor:pointer;"></td>
      <td style="padding:8px 12px;"><div style="display:flex;align-items:center;">${icon}<span style="font-size:0.82rem;">${g.name}</span></div></td>
      <td style="padding:8px 6px;"><span class="tag ${tagClass}">${tagLabel}</span></td>
      <td style="text-align:right;padding:8px 12px;font-size:0.82rem;color:var(--muted);">×${g.count}</td>
      <td style="text-align:right;padding:8px 8px;">
        <input type="number" id="price-${safeId}" placeholder="${median || 'Price'}" value="${median}" style="width:100%;padding:5px 8px;font-size:0.78rem;text-align:right;">
      </td>
    </tr>`;
  });
}

function commsSelectAll() { document.querySelectorAll('.comms-check').forEach((c) => c.checked = true); }
function commsSelectNone() { document.querySelectorAll('.comms-check').forEach((c) => c.checked = false); }

function generateListing() {
  const checks = [...document.querySelectorAll('.comms-check:checked')];
  if (checks.length === 0) {
    document.getElementById('metaforgePreview').textContent = 'Select at least one item first.';
    return;
  }

  const items = checks.map((c) => ({
    name: c.dataset.name,
    source: c.dataset.source,
    count: parseInt(c.dataset.count),
    price: parseInt(document.getElementById(`price-${c.dataset.id}`)?.value) || null,
  }));

  const quickTrades = document.getElementById('opt-quickTrades')?.checked;
  const acceptOffers = document.getElementById('opt-acceptOffers')?.checked;
  const bulkDiscount = document.getElementById('opt-bulkDiscount')?.checked;
  const bulkPct = parseInt(document.getElementById('opt-bulkPct')?.value) || 10;
  const notes = (document.getElementById('opt-notes')?.value || '').trim();

  // ── Build phrase list ──
  const parts = [];

  // Opener
  if (items.length === 1) {
    parts.push(rnd(P.singleOpeners).replace('{item}', items[0].name));
  } else {
    parts.push(rnd(P.openers));
  }

  // Conditions (interspersed naturally before items for Metaforge)
  if (quickTrades) parts.push(rnd(P.quickTrades));
  if (acceptOffers) parts.push(rnd(P.acceptOffers));
  if (bulkDiscount && items.length > 1) parts.push(rnd(P.bulkDiscount).replace('{pct}', bulkPct));
  if (notes) parts.push(`📝 ${notes}`);

  // Closer — 50% chance connector+closer, 50% just closer
  if (Math.random() > 0.5) {
    parts.push(rnd(P.closers));
  } else {
    parts.push(`${rnd(P.connectors)} ${rnd(P.closers)}`);
  }

  // Metaforge: single continuous string, add profile note for more listings
  const profileNote = rnd([
    'Check my profile for all active listings.',
    'More items on my profile.',
    'See my profile for full inventory.',
    'Browse my profile for more.',
  ]);
  const metaforge = [...parts, profileNote].join(' ');

  // Discord: structured item table, no source tags, make an offer if no price
  const discordItems = items.map((item) => {
    const priceStr = item.price ? `${item.price.toLocaleString()} seeds` : 'Make an offer';
    return `${item.name}  ×${item.count}  |  ${priceStr}`;
  }).join('\n');

  const discord = `${metaforge}\n\`\`\`\n${discordItems}\n\`\`\`\n-# via Speranza Logistics Terminal`;

  listingOutput = { metaforge, discord };
  document.getElementById('metaforgePreview').textContent = metaforge;
  renderDiscordPreview(discord);
}

function renderDiscordPreview(text) {
  const el = document.getElementById('discordPreview');
  if (!el) return;
  let html = text
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/`{3}([\s\S]*?)`{3}/g, '<code style="display:block;background:#1e1f22;padding:8px 10px;border-radius:4px;font-family:monospace;font-size:0.8rem;white-space:pre;">$1</code>')
    .replace(/^> (.+)$/gm, '<span style="border-left:3px solid #4e5058;padding-left:8px;color:#b5bac1;">$1</span>')
    .replace(/^-# (.+)$/gm, '<span style="font-size:0.72rem;color:#80848e;">$1</span>')
    .replace(/\n/g, '<br>');
  el.innerHTML = html;
}

function copyListing(format) {
  const text = format === 'discord' ? listingOutput?.discord : listingOutput?.metaforge;
  if (!text) return;
  navigator.clipboard.writeText(text).then(() => {
    const btn = document.querySelector(format === 'discord' ? '[onclick="copyListing(\'discord\')"]' : '[onclick="copyListing(\'metaforge\')"]');
    if (btn) { const orig = btn.textContent; btn.textContent = '✓ Copied!'; setTimeout(() => btn.textContent = orig, 1500); }
  });
}

// ─── Theme engine ─────────────────────────────────────────────────────────────

const PALETTES = {
  'arc':       { bg0:'#06080a', bg1:'#0c0f14', bg2:'#12161d', bg3:'#181d26', border:'#1e2633', borderBright:'#2a3544', muted:'#64748b', text:'#e2e8f0', textDim:'#94a3b8', cyan:'#06b6d4', cyanDim:'rgba(6,182,212,0.15)', amber:'#f59e0b', amberDim:'rgba(245,158,11,0.15)', emerald:'#10b981', emeraldDim:'rgba(16,185,129,0.15)', violet:'#8b5cf6', violetDim:'rgba(139,92,246,0.15)', rose:'#f43f5e', glow:'rgba(6,182,212,0.08)' },
  'tactical':  { bg0:'#080a05', bg1:'#0f1209', bg2:'#161a0e', bg3:'#1e2414', border:'#2a3018', borderBright:'#3a4222', muted:'#6b7a4a', text:'#d4dbb0', textDim:'#a0aa78', cyan:'#8db842', cyanDim:'rgba(141,184,66,0.15)', amber:'#e8a020', amberDim:'rgba(232,160,32,0.15)', emerald:'#4caf50', emeraldDim:'rgba(76,175,80,0.15)', violet:'#b8860b', violetDim:'rgba(184,134,11,0.15)', rose:'#e05050', glow:'rgba(141,184,66,0.06)' },
  'slate':     { bg0:'#0a0a0b', bg1:'#111115', bg2:'#18181c', bg3:'#1e1e24', border:'#2a2a32', borderBright:'#3a3a45', muted:'#6b6b7a', text:'#dddde8', textDim:'#9898aa', cyan:'#818cf8', cyanDim:'rgba(129,140,248,0.15)', amber:'#a78bfa', amberDim:'rgba(167,139,250,0.15)', emerald:'#34d399', emeraldDim:'rgba(52,211,153,0.15)', violet:'#f472b6', violetDim:'rgba(244,114,182,0.15)', rose:'#fb7185', glow:'rgba(129,140,248,0.06)' },
  'neon':      { bg0:'#000000', bg1:'#080808', bg2:'#0f0f0f', bg3:'#161616', border:'#222222', borderBright:'#333333', muted:'#555555', text:'#f0f0f0', textDim:'#aaaaaa', cyan:'#00ffcc', cyanDim:'rgba(0,255,204,0.12)', amber:'#ffcc00', amberDim:'rgba(255,204,0,0.12)', emerald:'#00ff88', emeraldDim:'rgba(0,255,136,0.12)', violet:'#cc44ff', violetDim:'rgba(204,68,255,0.12)', rose:'#ff4466', glow:'rgba(0,255,204,0.05)' },
  'dusk':      { bg0:'#0d0810', bg1:'#130d18', bg2:'#1a1222', bg3:'#21182c', border:'#2e2040', borderBright:'#3d2c55', muted:'#7a6a90', text:'#e8ddf5', textDim:'#b8a8cc', cyan:'#c084fc', cyanDim:'rgba(192,132,252,0.15)', amber:'#fb923c', amberDim:'rgba(251,146,60,0.15)', emerald:'#4ade80', emeraldDim:'rgba(74,222,128,0.15)', violet:'#e879f9', violetDim:'rgba(232,121,249,0.15)', rose:'#f87171', glow:'rgba(192,132,252,0.07)' },
  'ash':       { bg0:'#0c0c0c', bg1:'#141414', bg2:'#1c1c1c', bg3:'#242424', border:'#303030', borderBright:'#404040', muted:'#707070', text:'#e8e8e8', textDim:'#a0a0a0', cyan:'#d0d0d0', cyanDim:'rgba(208,208,208,0.12)', amber:'#c8c8c8', amberDim:'rgba(200,200,200,0.12)', emerald:'#b0b0b0', emeraldDim:'rgba(176,176,176,0.12)', violet:'#909090', violetDim:'rgba(144,144,144,0.12)', rose:'#e87070', glow:'rgba(200,200,200,0.04)' },
};

const FONT_PAIRS = {
  'default':  { ui: "'Outfit', system-ui, sans-serif",        mono: "'JetBrains Mono', monospace" },
  'allMono':  { ui: "'JetBrains Mono', monospace",            mono: "'JetBrains Mono', monospace" },
  'modern':   { ui: "'Inter', 'Outfit', system-ui, sans-serif", mono: "'Fira Code', 'JetBrains Mono', monospace" },
};

const DENSITIES = {
  comfortable: { tdPadding: '10px 16px', inputPadding: '10px 14px', btnPadding: '10px 18px', fontSize: '0.85rem' },
  compact:     { tdPadding: '6px 12px',  inputPadding: '7px 10px',  btnPadding: '7px 14px',  fontSize: '0.8rem'  },
};

const BORDER_STYLES = {
  rounded: { card: '12px', btn: '8px', input: '8px', tag: '6px' },
  sharp:   { card: '0px',  btn: '2px', input: '2px', tag: '2px' },
  pill:    { card: '16px', btn: '999px', input: '8px', tag: '999px' },
};

const PRESETS = {
  terminal: { palette: 'arc',      fonts: 'default', density: 'comfortable', borders: 'rounded', nav: 'sidebar' },
  tactical: { palette: 'tactical', fonts: 'allMono', density: 'compact',     borders: 'sharp',   nav: 'sidebar' },
  clean:    { palette: 'dusk',     fonts: 'modern',  density: 'comfortable', borders: 'pill',    nav: 'topnav'  },
  neon:     { palette: 'neon',     fonts: 'allMono', density: 'compact',     borders: 'sharp',   nav: 'sidebar' },
};

let currentTheme = JSON.parse(localStorage.getItem(STORAGE_KEYS.theme) || 'null') || { ...PRESETS.terminal };

function applyTheme(t) {
  currentTheme = t;
  pendingTheme = { ...t };
  pendingPreset = Object.keys(PRESETS).find((k) => Object.keys(PRESETS[k]).every((p) => PRESETS[k][p] === t[p])) || 'custom';
  localStorage.setItem(STORAGE_KEYS.theme, JSON.stringify(t));

  const p = PALETTES[t.palette] || PALETTES.arc;
  const f = FONT_PAIRS[t.fonts] || FONT_PAIRS.default;
  const d = DENSITIES[t.density] || DENSITIES.comfortable;
  const b = BORDER_STYLES[t.borders] || BORDER_STYLES.rounded;

  const root = document.documentElement;
  root.style.setProperty('--bg-0', p.bg0);
  root.style.setProperty('--bg-1', p.bg1);
  root.style.setProperty('--bg-2', p.bg2);
  root.style.setProperty('--bg-3', p.bg3);
  root.style.setProperty('--border', p.border);
  root.style.setProperty('--border-bright', p.borderBright);
  root.style.setProperty('--muted', p.muted);
  root.style.setProperty('--text', p.text);
  root.style.setProperty('--text-dim', p.textDim);
  root.style.setProperty('--cyan', p.cyan);
  root.style.setProperty('--cyan-dim', p.cyanDim);
  root.style.setProperty('--amber', p.amber);
  root.style.setProperty('--amber-dim', p.amberDim);
  root.style.setProperty('--emerald', p.emerald);
  root.style.setProperty('--emerald-dim', p.emeraldDim);
  root.style.setProperty('--violet', p.violet);
  root.style.setProperty('--violet-dim', p.violetDim);
  root.style.setProperty('--rose', p.rose);
  root.style.setProperty('--theme-glow', p.glow);

  // Fonts — via CSS var only, no inline body style
  root.style.setProperty('--font-ui', f.ui);
  root.style.setProperty('--font-mono', f.mono);

  // Density
  root.style.setProperty('--td-padding', d.tdPadding);
  root.style.setProperty('--input-padding', d.inputPadding);
  root.style.setProperty('--btn-padding', d.btnPadding);
  root.style.setProperty('--base-font-size', d.fontSize);

  // Borders
  root.style.setProperty('--radius-card', b.card);
  root.style.setProperty('--radius-btn', b.btn);
  root.style.setProperty('--radius-input', b.input);
  root.style.setProperty('--radius-tag', b.tag);

  // Background — via CSS var, body rule uses it
  root.style.setProperty('--body-bg-image',
    `radial-gradient(ellipse 80% 50% at 50% -20%, ${p.glow}, transparent), linear-gradient(180deg, ${p.bg0} 0%, ${p.bg1} 100%)`);

  // Nav layout — these are structural so inline is unavoidable, but they're symmetrical
  const sidebar = document.querySelector('.sidebar');
  const topnav = document.getElementById('topnav');
  const appEl = document.querySelector('.app');
  if (t.nav === 'topnav') {
    if (sidebar) sidebar.style.display = 'none';
    if (topnav) topnav.style.display = 'flex';
    if (appEl) appEl.style.flexDirection = 'column';
  } else {
    if (sidebar) sidebar.style.display = '';
    if (topnav) topnav.style.display = 'none';
    if (appEl) appEl.style.flexDirection = '';
  }

  // Update active states in theme UI
  updateThemeUI();
}

let pendingTheme = { ...currentTheme };
let pendingPreset = Object.keys(PRESETS).find((k) => Object.keys(PRESETS[k]).every((p) => PRESETS[k][p] === currentTheme[p])) || 'custom';

function applyPreset(name) {
  if (name === 'custom') {
    // Keep current pending values, just switch to custom mode
    pendingPreset = 'custom';
  } else {
    const preset = PRESETS[name];
    if (!preset) return;
    pendingTheme = { ...preset };
    pendingPreset = name;
  }
  updateThemeUI();
}

function setThemeProp(prop, value) {
  pendingTheme = { ...pendingTheme, [prop]: value };
  pendingPreset = 'custom';
  updateThemeUI();
}

function applyPendingTheme() {
  applyTheme(pendingTheme);
}

function updateThemeUI() {
  // Preset buttons — only one ever highlighted (including Custom)
  document.querySelectorAll('[data-preset]').forEach((btn) => {
    const active = btn.dataset.preset === pendingPreset;
    btn.style.borderColor = active ? 'var(--cyan)' : 'var(--border)';
    btn.style.color = active ? 'var(--cyan)' : 'var(--text-dim)';
    btn.style.background = active ? 'var(--cyan-dim)' : '';
  });

  // Custom controls visibility
  const controls = document.getElementById('customThemeControls');
  if (controls) {
    controls.style.display = pendingPreset === 'custom' ? 'block' : 'none';
  }

  // Individual option buttons
  ['palette', 'fonts', 'density', 'borders', 'nav'].forEach((prop) => {
    document.querySelectorAll(`[data-theme-prop="${prop}"]`).forEach((btn) => {
      const active = btn.dataset.themeVal === pendingTheme[prop];
      btn.style.background = active ? 'var(--cyan-dim)' : 'var(--bg-3)';
      btn.style.borderColor = active ? 'var(--cyan)' : 'var(--border)';
      btn.style.color = active ? 'var(--cyan)' : 'var(--text-dim)';
    });
  });

  // Apply button state
  const applyBtn = document.getElementById('themeApplyBtn');
  if (applyBtn) {
    const dirty = JSON.stringify(pendingTheme) !== JSON.stringify(currentTheme);
    applyBtn.style.opacity = dirty ? '1' : '0.45';
    applyBtn.textContent = dirty ? 'Apply Theme ✦' : 'Applied';
  }
}

function resetTheme() {
  applyTheme({ ...PRESETS.terminal });
  pendingTheme = { ...PRESETS.terminal };
  pendingPreset = 'terminal';
  localStorage.removeItem(STORAGE_KEYS.theme);
  updateThemeUI();
}

function randomizeTheme() {
  const palKeys = Object.keys(PALETTES);
  const fontKeys = Object.keys(FONT_PAIRS);
  const densityKeys = Object.keys(DENSITIES);
  const borderKeys = Object.keys(BORDER_STYLES);
  const navKeys = ['sidebar', 'topnav'];
  const rnd = (arr) => arr[Math.floor(Math.random() * arr.length)];
  pendingTheme = { palette: rnd(palKeys), fonts: rnd(fontKeys), density: rnd(densityKeys), borders: rnd(borderKeys), nav: rnd(navKeys) };
  pendingPreset = 'custom';
  updateThemeUI();
}

// ─── Scrap advisor ────────────────────────────────────────────────────────────
function openScrapAdvisor() {
  const modal = document.getElementById('scrapModal');
  if (!modal) return;
  const tbody = document.getElementById('scrapList');
  if (!tbody) return;
  tbody.innerHTML = '';

  const validSells = audit.filter((a) => a.action === ACTIONS.SELL && ![ACTIONS.VOID, ACTIONS.REVERTED].includes(a.action));
  const sessionCount = Math.max(1, audit.filter((a) => a.action === ACTIONS.SESSION_START).length);

  const sellStats = {};
  validSells.forEach((a) => {
    if (!sellStats[a.name]) sellStats[a.name] = { totalQty: 0 };
    sellStats[a.name].totalQty += a.qty;
  });

  // Group non-blueprint stock
  const grouped = stock.reduce((acc, item) => {
    if ((itemTypeMap[item.name] || item.item_type) === 'Blueprint') return acc;
    acc[item.name] = (acc[item.name] || 0) + 1;
    return acc;
  }, {});

  if (Object.keys(grouped).length === 0) {
    tbody.innerHTML = '<tr><td colspan="4" style="text-align:center;color:var(--muted);padding:2rem;">No scrappable items in warehouse.</td></tr>';
    modal.style.display = 'flex';
    return;
  }

  const rows = Object.entries(grouped).map(([name, qty]) => {
    const stackSize = stackMap[name] || 1;
    const stats = sellStats[name];
    const medianPrice = priceCache[name] || null;
    const seedsPerSlot = medianPrice ? medianPrice * stackSize : null;
    const avgSellsPerSession = stats ? stats.totalQty / sessionCount : 0;
    const daysOfSupply = avgSellsPerSession > 0 ? qty / avgSellsPerSession : null;
    const safeReserve = avgSellsPerSession > 0 ? Math.max(1, Math.ceil(avgSellsPerSession * 3)) : 1;
    const suggestedScrap = Math.max(0, qty - safeReserve);

    let score = 0;
    if (!stats) score = 900 + qty;
    else {
      const supplyScore = daysOfSupply ? Math.min(daysOfSupply * 10, 500) : 0;
      const valueScore = seedsPerSlot ? Math.max(0, 200 - seedsPerSlot / 10) : 100;
      score = supplyScore + valueScore;
    }

    let reasoning = '';
    if (!stats) reasoning = 'Never sold — unknown demand';
    else if (daysOfSupply > 20) reasoning = `~${Math.round(daysOfSupply)} sessions of supply`;
    else if (daysOfSupply > 10) reasoning = `~${Math.round(daysOfSupply)} sessions of stock`;
    else reasoning = `~${avgSellsPerSession.toFixed(1)}/session sell rate`;
    if (seedsPerSlot) reasoning += ` · ${Math.floor(seedsPerSlot).toLocaleString()} seeds/slot`;

    return { name, qty, suggestedScrap, reasoning, score, noHistory: !stats };
  }).sort((a, b) => b.score - a.score);

  rows.forEach((r) => {
    const scrapDefault = r.suggestedScrap > 0 ? r.suggestedScrap : 1;
    const scrapId = `scrap-${r.name.replace(/[^a-z0-9]/gi, '_')}`;
    tbody.innerHTML += `<tr>
      <td><div style="display:flex;align-items:center;gap:8px;">${itemIcon(r.name, 20)}<span style="font-size:0.82rem;">${r.name}</span></div></td>
      <td class="font-mono" style="text-align:right;color:var(--muted);">×${r.qty}</td>
      <td style="font-size:0.75rem;color:var(--muted);">${r.reasoning}</td>
      <td style="text-align:right;white-space:nowrap;">
        <span style="font-size:0.72rem;color:var(--muted);margin-right:4px;">Scrap</span>
        <input type="number" id="${scrapId}" value="${scrapDefault}" min="1" max="${r.qty - 1}"
          style="width:52px;padding:4px 6px;font-size:0.8rem;text-align:center;display:inline-block;">
        <button class="btn btn-ghost" onclick="scrapItem('${r.name.replace(/'/g, "\\'")}', '${scrapId}')"
          style="padding:4px 10px;font-size:0.7rem;color:var(--rose);border:1px solid rgba(244,63,94,0.3);margin-left:4px;">Scrap</button>
      </td>
    </tr>`;
  });

  if (!tbody.innerHTML) {
    tbody.innerHTML = '<tr><td colspan="4" style="text-align:center;color:var(--muted);padding:2rem;">Nothing flagged — stock looks balanced.</td></tr>';
  }

  modal.style.display = 'flex';
}

function scrapItem(name, inputId) {
  const qty = parseInt(document.getElementById(inputId)?.value) || 0;
  if (qty <= 0) return;
  const inStock = stock.filter((s) => s.name === name).length;
  if (qty >= inStock) { alert(`Keep at least 1 — you have ${inStock} in stock.`); return; }
  if (!confirm(`Scrap ${qty}× ${name}? Removed from warehouse, no sale recorded.`)) return;
  let removed = 0;
  for (let i = stock.length - 1; i >= 0 && removed < qty; i--) {
    if (stock[i].name === name) { stock.splice(i, 1); removed++; }
  }
  audit.push({ id: genId(), ts: Date.now(), action: ACTIONS.ADJUST, name: `Scrapped ${qty}× ${name}`, qty, price: 0, cost: 0, source: SOURCES.SYS });
  render();
  openScrapAdvisor();
}

function closeScrapModal() {
  const modal = document.getElementById('scrapModal');
  if (modal) modal.style.display = 'none';
}

// ─── Sell from reserve ────────────────────────────────────────────────────────
function sellFromReserve() {
  const name = (document.getElementById('reserveName').value || '').trim();
  const qty = parseInt(document.getElementById('reserveQty').value) || 0;
  const price = parseFloat(document.getElementById('reservePrice').value) || 0;
  if (!name || qty <= 0 || price <= 0) return;
  liquidSeeds += price * qty;
  audit.push({ id: genId(), ts: Date.now(), action: ACTIONS.SELL, name, qty, price, cost: 0, source: SOURCES.LOOTED,
    revertData: { deltaLiquid: -(price * qty), addStock: [] } });
  document.getElementById('reserveName').value = '';
  document.getElementById('reserveQty').value = '1';
  document.getElementById('reservePrice').value = '';
  render();
}

function init() {
  Object.assign(window, {
    switchTab, massIngest, buyItem, executeBarter,
    generateRandomHistory, adjustBalance, resyncMetaforge,
    exportData, importData, voidEntry, revertEntry, sellX, sellAll,
    startNewSession, showPriceHistory, closePriceHistory, handleModalClick,
    toggleCustomItems, mergeCustomItems, addStartingStock, setStaleThreshold,
    generateListing, copyListing, commsSelectAll, commsSelectNone,
    applyPreset, setThemeProp, applyPendingTheme, resetTheme, randomizeTheme,
    openScrapAdvisor, closeScrapModal, scrapItem, sellFromReserve,
  });

  applyTheme(currentTheme);
  pendingTheme = { ...currentTheme };
  pendingPreset = Object.keys(PRESETS).find((k) => Object.keys(PRESETS[k]).every((p) => PRESETS[k][p] === currentTheme[p])) || 'custom';

  loadMetaforgeCache();
  initTextareaAutocomplete();
  initInputAutocomplete('buyName');
  initInputAutocomplete('tradeTo');
  initInputAutocomplete('reserveName');

  const customToggle = document.getElementById('allowCustomItemsToggle');
  if (customToggle) customToggle.checked = allowCustomItems;
  const mergeBlock = document.getElementById('customMergeBlock');
  if (mergeBlock) mergeBlock.style.display = allowCustomItems ? '' : 'none';
  const staleInput = document.getElementById('staleThresholdInput');
  if (staleInput) staleInput.value = staleThresholdDays;

  (async () => {
    try {
      if (!apiItems || apiItems.length === 0) {
        apiItems = await fetchMetaforgeFromLocalFile();
        if (apiItems.length) {
          buildDerivedItemData(apiItems);
          writeJson(STORAGE_KEYS.metaforgeCache, apiItems);
          localStorage.setItem(STORAGE_KEYS.metaforgeCacheTs, String(Date.now()));
          const el = document.getElementById('metaforgeStatus');
          if (el) el.textContent = `Synced (site data) ${new Date().toLocaleString()} (${apiItems.length} items)`;
        }
      }
    } catch { /* ignore */ }
    try { quests = await fetchQuestsFromLocalFile(); buildQuestDemandMap(quests); } catch { quests = []; }
    render();
  })();

  if (audit.length === 0) {
    const seed = parseFloat(prompt('Enter initial Seed Capital:', '0')) || 0;
    liquidSeeds = seed;
    audit.push({ id: genId(), ts: Date.now(), action: ACTIONS.INITIAL, name: 'Starting Capital', qty: 1, price: seed, cost: 0, source: SOURCES.SYS });
  }
  render();
}

init();
