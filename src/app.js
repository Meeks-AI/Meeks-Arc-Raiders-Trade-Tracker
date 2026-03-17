/* global Chart */
'use strict';

// NOTE: This file is intentionally written as a browser ES module.
// It exposes a small API on `window` for the existing inline onclick handlers.

import { ACTIONS, LOCAL_METAFORGE_ITEMS_URL, METAFORGE_URL, STORAGE_KEYS } from './constants.js';
import { readJson, readNumber, writeJson } from './storage.js';

let stock = readJson(STORAGE_KEYS.stock, []);
let audit = readJson(STORAGE_KEYS.audit, []);
let liquidSeeds = readNumber(STORAGE_KEYS.liquidSeeds, 0);
let priceCache = {};
let apiItems = [];
let aliasMap = readJson(STORAGE_KEYS.itemAliases, { 'Anvil BP': 'Anvil Blueprint', Seeds: 'Raw Seeds' });
let chartInstance = null;

function genId() {
  return `e${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
}

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
  let page = 1;
  let hasMore = true;
  const limit = 100;
  const maxPages = 200;

  while (hasMore) {
    if (page > maxPages) throw new Error(`Safety stop: exceeded maxPages (${maxPages}).`);
    const res = await fetch(`${METAFORGE_URL}/items?page=${page}&limit=${limit}&minimal=true`);
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
  if (btn) {
    btn.disabled = true;
    btn.textContent = 'Syncing...';
  }
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
  if (btn) {
    btn.disabled = false;
    btn.textContent = 'Resync API';
  }
  render();
}

function normalizeItemName(input) {
  if (!input || typeof input !== 'string') return input;
  const t = input.trim();
  const lower = t.toLowerCase();
  const canon = aliasMap[t] || Object.entries(aliasMap).find(([k]) => k.toLowerCase() === lower)?.[1];
  if (canon) return canon;
  const match = apiItems.find((i) => (i.name || '').toLowerCase() === lower);
  return match ? match.name : t;
}

function buildPriceCache() {
  priceCache = {};
  const sells = audit.filter((a) => a.action === ACTIONS.SELL && a.name !== 'Raw Seeds');
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

function switchTab(t) {
  document.querySelectorAll('.tab-content').forEach((e) => e.classList.remove('active'));
  document.querySelectorAll('.nav-btn').forEach((b) => b.classList.remove('active'));
  document.getElementById(`view-${t}`)?.classList.add('active');
  document.getElementById(`nav-${t}`)?.classList.add('active');
  if (t === 'analytics') renderAnalytics();
}

function render() {
  buildPriceCache();
  const invBody = document.getElementById('inventoryTable');
  const auditBody = document.getElementById('auditTable');
  const barterSelect = document.getElementById('tradeFrom');
  const mergeSelect = document.getElementById('mergeFrom');
  const dataList = document.getElementById('itemOptions');
  const searchQuery = (document.getElementById('invSearch')?.value || '').toLowerCase();

  if (!invBody || !auditBody || !barterSelect || !mergeSelect || !dataList) return;

  invBody.innerHTML = '';
  auditBody.innerHTML = '';
  dataList.innerHTML = '';
  barterSelect.innerHTML = '<option value="">— Choose item —</option>';
  mergeSelect.innerHTML = '<option value="">— Select —</option>';

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
      invBody.innerHTML += `<tr>
          <td class="font-mono font-semibold">${g.name}</td>
          <td><span class="tag ${tag}">${g.source}</span></td>
          <td class="font-mono">×${g.count}</td>
          <td class="font-mono text-[var(--muted)]">${Math.floor(g.cost).toLocaleString()}</td>
          <td class="font-mono ${mp ? 'text-[var(--cyan)]' : 'text-[var(--muted)]'}">${mp ? Math.floor(mp).toLocaleString() : '—'}</td>
          <td style="text-align:right">
              <input type="number" id="q-${safeId}" value="1" min="1" max="${g.count}" style="width:52px;padding:6px;margin-right:4px;display:inline-block">
              <input type="number" id="p-${safeId}" placeholder="Price" style="width:72px;padding:6px;margin-right:6px;display:inline-block">
              <button class="btn btn-ghost" style="padding:6px 12px;font-size:0.7rem" onclick="sellX('${g.name.replace(/'/g, "\\'")}', '${g.source}', ${g.cost}, '${safeId}')">Sell</button>
          </td>
      </tr>`;
      barterSelect.innerHTML += `<option value="${g.name}|${g.source}|${g.cost}">${g.name} [${g.source}] ×${g.count}</option>`;
    });

  for (let idx = audit.length - 1; idx >= 0; idx--) {
    const entry = audit[idx];
    const isSell = entry.action === ACTIONS.SELL;
    const isCurrency = entry.action === ACTIONS.CURRENCY;
    const isInitial = entry.action === ACTIONS.INITIAL;
    const isVoid = entry.action === ACTIONS.VOID;
    const isReverted = entry.action === ACTIONS.REVERTED;
    const isBarter = entry.action === ACTIONS.BARTER;
    const isExcluded = isVoid || isReverted;

    const profitDelta =
      isInitial || isVoid || isReverted || isBarter
        ? 0
        : isCurrency
          ? entry.price
          : isSell
            ? (entry.price - entry.cost) * entry.qty
            : 0;

    if (!isExcluded) totalProfit += profitDelta;

    const time = new Date(entry.ts).toLocaleString([], {
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    });
    const actClr =
      profitDelta > 0
        ? 'color:var(--emerald)'
        : profitDelta < 0
          ? 'color:var(--rose)'
          : isInitial
            ? 'color:var(--cyan)'
            : isExcluded
              ? 'color:var(--muted)'
              : isBarter
                ? 'color:#a78bfa'
                : '';

    auditBody.insertAdjacentHTML(
      'beforeend',
      `<tr style="${isExcluded ? 'opacity:0.5' : ''}">
          <td class="font-mono" style="font-size:0.75rem;color:var(--muted)">${time}</td>
          <td style="font-weight:600;font-size:0.75rem;${actClr}">${entry.action}</td>
          <td style="${isExcluded ? 'text-decoration:line-through' : ''}">${entry.name}</td>
          <td class="font-mono" style="color:var(--muted)">${isCurrency || isInitial ? '—' : '×' + entry.qty}</td>
          <td style="text-align:right;font-weight:600;${profitDelta >= 0 ? 'color:var(--amber)' : 'color:var(--rose)'}">${profitDelta !== 0 ? (profitDelta > 0 ? '+' : '') + Math.floor(profitDelta).toLocaleString() : isInitial || isBarter ? Math.floor(entry.price).toLocaleString() : '—'}</td>
          <td style="text-align:right">${!isExcluded && entry.action !== ACTIONS.INITIAL ? `<button class="btn btn-ghost" style="padding:2px 6px;font-size:0.65rem" onclick="voidEntry(${idx})">Void</button><button class="btn btn-ghost" style="padding:2px 6px;font-size:0.65rem" onclick="revertEntry(${idx})">Revert</button>` : isReverted ? '<span style="font-size:0.7rem;color:var(--muted)">Reverted</span>' : ''}</td>
      </tr>`,
    );
  }

  const allNames = [
    ...new Set([...stock.map((i) => i.name), ...audit.map((i) => i.name), ...apiItems.map((i) => i.name)]),
  ]
    .filter(Boolean)
    .sort();

  allNames.forEach((n) => {
    dataList.innerHTML += `<option value="${n}">`;
    mergeSelect.innerHTML += `<option value="${n}">${n}</option>`;
  });

  document.getElementById('liquidDisplay').textContent = Math.floor(liquidSeeds).toLocaleString();
  document.getElementById('assetValuation').textContent = Math.floor(assetValuation).toLocaleString();
  document.getElementById('netWorth').textContent = Math.floor(liquidSeeds + assetValuation).toLocaleString();
  document.getElementById('totalProfit').textContent = Math.floor(totalProfit).toLocaleString();
  document.getElementById('invCount').textContent = stock.length;

  writeJson(STORAGE_KEYS.stock, stock);
  writeJson(STORAGE_KEYS.audit, audit);
  localStorage.setItem(STORAGE_KEYS.liquidSeeds, String(liquidSeeds));
}

function massIngest() {
  const raw = (document.getElementById('bulkText').value || '').trim();
  if (!raw) return;
  raw.split('\n').forEach((line) => {
    const nums = line.match(/\d+/);
    const text = normalizeItemName(line.replace(/\d+/, '').trim());
    const qty = nums ? parseInt(nums[0], 10) : 1;
    if (!text) return;
    if (text.toLowerCase() === 'raw seeds' || text.toLowerCase() === 'seeds') {
      liquidSeeds += qty;
      audit.push({
        id: genId(),
        ts: Date.now(),
        action: ACTIONS.CURRENCY,
        name: 'Raw Seeds',
        qty: 1,
        price: qty,
        cost: 0,
        source: 'FIR',
        revertData: { deltaLiquid: -qty },
      });
    } else {
      for (let i = 0; i < qty; i++) stock.push({ name: text, cost: 0, source: 'FIR' });
      audit.push({
        id: genId(),
        ts: Date.now(),
        action: ACTIONS.RECOVERY,
        name: text,
        qty,
        price: 0,
        cost: 0,
        source: 'FIR',
        revertData: { removeStock: [{ name: text, source: 'FIR', cost: 0, qty }] },
      });
    }
  });
  document.getElementById('bulkText').value = '';
  render();
}

function buyItem() {
  const name = normalizeItemName((document.getElementById('buyName').value || '').trim());
  const qty = parseInt(document.getElementById('buyQty').value, 10) || 1;
  const costPer = parseFloat(document.getElementById('buyPrice').value) || 0;
  if (!name) return;
  const total = costPer * qty;
  liquidSeeds -= total;
  for (let i = 0; i < qty; i++) stock.push({ name, cost: costPer, source: 'BUY' });
  audit.push({
    id: genId(),
    ts: Date.now(),
    action: ACTIONS.PURCHASE,
    name,
    qty,
    price: costPer,
    cost: costPer,
    source: 'BUY',
    revertData: { deltaLiquid: total, removeStock: { name, source: 'BUY', cost: costPer, qty } },
  });
  document.getElementById('buyName').value = '';
  document.getElementById('buyPrice').value = '';
  render();
}

function sellX(name, source, cost, safeId) {
  const p = parseFloat(document.getElementById(`p-${safeId}`).value);
  const q = parseInt(document.getElementById(`q-${safeId}`).value, 10) || 1;
  if (Number.isNaN(p) || q <= 0) return;
  const matches = stock.filter((i) => i.name === name && i.source === source && Math.floor(i.cost) === Math.floor(cost));
  if (matches.length < q) {
    alert(`Only ${matches.length} in stock.`);
    return;
  }
  let removed = 0;
  for (let i = stock.length - 1; i >= 0 && removed < q; i--) {
    if (stock[i].name === name && stock[i].source === source && Math.floor(stock[i].cost) === Math.floor(cost)) {
      stock.splice(i, 1);
      removed++;
    }
  }
  liquidSeeds += p * q;
  const addBack = [];
  for (let i = 0; i < q; i++) addBack.push({ name, source, cost });
  audit.push({
    id: genId(),
    ts: Date.now(),
    action: ACTIONS.SELL,
    name,
    qty: q,
    price: p,
    cost,
    source,
    revertData: { deltaLiquid: -(p * q), addStock: addBack },
  });
  render();
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

  const unitVal = parseFloat(oldCost) > 0 ? parseFloat(oldCost) : priceCache[oldName] || 0;
  const totalVal = unitVal * fromQty;

  let removed = 0;
  for (let i = stock.length - 1; i >= 0 && removed < fromQty; i--) {
    if (stock[i].name === oldName && stock[i].source === oldSrc && Math.floor(stock[i].cost) === Math.floor(oldCost)) {
      stock.splice(i, 1);
      removed++;
    }
  }

  const toNorm = normalizeItemName(toName);
  const costPer = Math.floor(totalVal / toQty);
  for (let i = 0; i < toQty; i++) stock.push({ name: toNorm, cost: costPer, source: 'TRD' });

  const addBack = [];
  for (let i = 0; i < fromQty; i++) addBack.push({ name: oldName, source: oldSrc, cost: parseFloat(oldCost) });

  audit.push({
    id: genId(),
    ts: Date.now(),
    action: ACTIONS.BARTER,
    name: `${fromQty}× ${oldName} → ${toQty}× ${toNorm}`,
    qty: toQty,
    price: totalVal,
    cost: totalVal,
    source: 'TRD',
    revertData: {
      removeStock: { name: toNorm, source: 'TRD', cost: costPer, qty: toQty },
      addStock: addBack,
    },
    barterFrom: { name: oldName, source: oldSrc, cost: parseFloat(oldCost), qty: fromQty },
    barterTo: { name: toNorm, qty: toQty },
  });

  document.getElementById('tradeTo').value = '';
  document.getElementById('tradeQty').value = '1';
  document.getElementById('tradeFromQty').value = '1';
  render();
}

function mergeItems() {
  const from = document.getElementById('mergeFrom').value;
  const to = (document.getElementById('mergeTo').value || '').trim();
  if (!from || !to || !confirm(`Merge "${from}" into "${to}"?`)) return;

  stock = stock.map((i) => (i.name === from ? { ...i, name: to } : i));
  audit = audit.map((a) => {
    if (a.name === from) return { ...a, name: to };
    if (a.action === ACTIONS.BARTER && a.name && a.name.includes('→')) {
      const [L, R] = a.name.split(' → ');
      const l = (L || '').replace(/^\d+×\s*/, '');
      const r = (R || '').replace(/^\d+×\s*/, '');
      if (l === from || r === from) {
        return {
          ...a,
          name: a.name.replace(new RegExp(`\\b${from.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'g'), to),
        };
      }
    }
    return a;
  });

  aliasMap[from] = to;
  writeJson(STORAGE_KEYS.itemAliases, aliasMap);
  render();
}

function generateRandomHistory() {
  if (!confirm('Replace all data with random test history?')) return;
  const now = Date.now();
  const day = 86400000;
  const ts = (d) => now - (7 - d) * day - Math.random() * day;

  audit = [];
  stock = [];
  liquidSeeds = 50000;

  audit.push({ id: genId(), ts: ts(0), action: ACTIONS.INITIAL, name: 'Starting Capital', qty: 1, price: 50000, cost: 0, source: 'SYS' });

  ['Iron Ore', 'Advanced Mechanical Components', 'Adrenaline Shot'].forEach((name, d) => {
    const qty = 2 + Math.floor(Math.random() * 4);
    for (let i = 0; i < qty; i++) stock.push({ name, cost: 0, source: 'FIR' });
    audit.push({
      id: genId(),
      ts: ts(d + 1),
      action: ACTIONS.RECOVERY,
      name,
      qty,
      price: 0,
      cost: 0,
      source: 'FIR',
      revertData: { removeStock: [{ name, source: 'FIR', cost: 0, qty }] },
    });
  });

  const sq = 1500 + Math.floor(Math.random() * 2000);
  liquidSeeds += sq;
  audit.push({ id: genId(), ts: ts(2), action: ACTIONS.CURRENCY, name: 'Raw Seeds', qty: 1, price: sq, cost: 0, source: 'FIR', revertData: { deltaLiquid: -sq } });

  const costPer = 4500;
  const bq = 2;
  liquidSeeds -= costPer * bq;
  for (let i = 0; i < bq; i++) stock.push({ name: 'Anvil Blueprint', cost: costPer, source: 'BUY' });
  audit.push({
    id: genId(),
    ts: ts(3),
    action: ACTIONS.PURCHASE,
    name: 'Anvil Blueprint',
    qty: bq,
    price: costPer,
    cost: costPer,
    source: 'BUY',
    revertData: { deltaLiquid: costPer * bq, removeStock: { name: 'Anvil Blueprint', source: 'BUY', cost: costPer, qty: bq } },
  });

  const sellQty = Math.min(3, stock.filter((s) => s.name === 'Iron Ore').length) || 2;
  let removed = 0;
  for (let i = stock.length - 1; i >= 0 && removed < sellQty; i--) {
    if (stock[i].name === 'Iron Ore' && stock[i].source === 'FIR') {
      stock.splice(i, 1);
      removed++;
    }
  }

  liquidSeeds += 1200 * sellQty;
  const ab = [];
  for (let i = 0; i < sellQty; i++) ab.push({ name: 'Iron Ore', source: 'FIR', cost: 0 });
  audit.push({ id: genId(), ts: ts(4), action: ACTIONS.SELL, name: 'Iron Ore', qty: sellQty, price: 1200, cost: 0, source: 'FIR', revertData: { deltaLiquid: -1200 * sellQty, addStock: ab } });
  audit.push({ id: genId(), ts: ts(5), action: ACTIONS.ADJUST, name: 'Manual Correction', qty: 1, price: -500, cost: 0, source: 'SYS', revertData: { deltaLiquid: 500 } });
  liquidSeeds -= 500;
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
  if (confirm('Void (cosmetic only)?')) {
    audit[idx].action = ACTIONS.VOID;
    render();
  }
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
          if (stock[i].name === name && stock[i].source === (source || 'TRD') && Math.floor(stock[i].cost) === Math.floor(cost || 0)) {
            stock.splice(i, 1);
            removed++;
          }
        }
      });
    }
  } else if (e.action === ACTIONS.BARTER && e.barterFrom && e.barterTo) {
    const from = e.barterFrom;
    const to = e.barterTo;
    const costPer = e.cost / to.qty;
    let removed = 0;
    for (let i = stock.length - 1; i >= 0 && removed < to.qty; i--) {
      if (stock[i].name === to.name && stock[i].source === 'TRD' && Math.floor(stock[i].cost) === Math.floor(costPer)) {
        stock.splice(i, 1);
        removed++;
      }
    }
    for (let i = 0; i < from.qty; i++) stock.push({ name: from.name, source: from.source, cost: from.cost });
  }
  audit[idx].action = ACTIONS.REVERTED;
  render();
}

function renderAnalytics() {
  const flipBody = document.getElementById('topFlipBody');
  const firBody = document.getElementById('topFirBody');
  const perBody = document.getElementById('perItemStatsBody');
  if (!flipBody || !firBody || !perBody) return;

  flipBody.innerHTML = '';
  firBody.innerHTML = '';
  perBody.innerHTML = '';

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

  Object.entries(stats)
    .sort((a, b) => b[1].profit - a[1].profit)
    .forEach(([name, s]) => {
      const row = `<tr><td>${name}</td><td style="text-align:right;color:var(--emerald);font-weight:600">+${Math.floor(s.profit).toLocaleString()}</td></tr>`;
      if (s.isFIR) firBody.innerHTML += row;
      else flipBody.innerHTML += row;
    });

  Object.entries(stats)
    .sort((a, b) => b[1].profit - a[1].profit)
    .forEach(([name, s]) => {
      const avgP = s.qty ? s.revenue / s.qty : 0;
      const avgC = s.qty ? s.costBasis / s.qty : 0;
      const roi = s.costBasis > 0 ? `${((s.profit / s.costBasis) * 100).toFixed(0)}%` : '—';
      const roiStyle = s.costBasis > 0 ? (s.profit >= 0 ? 'color:var(--emerald)' : 'color:var(--rose)') : 'color:var(--muted)';
      perBody.innerHTML += `<tr><td class="font-semibold">${name}</td><td style="text-align:right">${s.qty}</td><td style="text-align:right" class="font-mono">${Math.floor(s.revenue).toLocaleString()}</td><td style="text-align:right" class="font-mono">${Math.floor(avgP).toLocaleString()}</td><td style="text-align:right;color:var(--muted)" class="font-mono">${Math.floor(avgC).toLocaleString()}</td><td style="text-align:right;color:var(--emerald);font-weight:600">+${Math.floor(s.profit).toLocaleString()}</td><td style="text-align:right;${roiStyle}" class="font-mono">${roi}</td></tr>`;
    });

  buildNetWorthChart();
}

function buildNetWorthChart() {
  const canvas = document.getElementById('chartCanvas');
  if (!canvas || typeof Chart === 'undefined') return;
  const valid = audit.filter((l) => ![ACTIONS.VOID, ACTIONS.REVERTED].includes(l.action));
  const points = [];
  let liquid = 0;
  let profit = 0;
  [...valid]
    .sort((a, b) => a.ts - b.ts)
    .forEach((e) => {
      if (e.action === ACTIONS.INITIAL) liquid = e.price || 0;
      else if (e.action === ACTIONS.CURRENCY || e.action === ACTIONS.ADJUST) liquid += e.price || 0;
      else if (e.action === ACTIONS.PURCHASE) liquid -= (e.cost || 0) * (e.qty || 1);
      else if (e.action === ACTIONS.SELL) {
        liquid += (e.price || 0) * (e.qty || 1);
        profit += ((e.price || 0) - (e.cost || 0)) * (e.qty || 1);
      }
      points.push({ ts: e.ts, liquid, profit });
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
      responsive: true,
      maintainAspectRatio: false,
      plugins: { legend: { labels: { color: '#94a3b8', font: { size: 11 } } } },
      scales: {
        x: { ticks: { color: '#64748b', maxTicksLimit: 10 }, grid: { color: '#1e2633' } },
        y: { ticks: { color: '#64748b' }, grid: { color: '#1e2633' } },
      },
    },
  });
}

function exportData() {
  const blob = new Blob([JSON.stringify({ stock, audit, liquidSeeds, aliasMap })], { type: 'application/json' });
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
    if (d.aliasMap) {
      aliasMap = d.aliasMap;
      writeJson(STORAGE_KEYS.itemAliases, aliasMap);
    }
    render();
  };
  r.readAsText(f);
}

function init() {
  // Expose API for current inline handlers (we'll remove these in the next iteration).
  Object.assign(window, {
    switchTab,
    massIngest,
    buyItem,
    executeBarter,
    mergeItems,
    generateRandomHistory,
    adjustBalance,
    resyncMetaforge,
    exportData,
    importData,
    voidEntry,
    revertEntry,
    sellX,
  });

  loadMetaforgeCache();

  // Same-origin fallback (GitHub Actions writes this file).
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
    } catch {
      // ignore
    }
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
