export const METAFORGE_URL = 'https://metaforge.app/api/arc-raiders';
export const LOCAL_METAFORGE_ITEMS_URL = './data/metaforge-items.json';
export const LOCAL_METAFORGE_QUESTS_URL = './data/metaforge-quests.json';

export const ACTIONS = Object.freeze({
  INITIAL: 'INITIAL',
  STOCK_INIT: 'STOCK_INIT',
  RECOVERY: 'RECOVERY',
  PURCHASE: 'PURCHASE',
  SELL: 'SELL',
  BARTER: 'BARTER',
  CURRENCY: 'CURRENCY',
  ADJUST: 'ADJUST',
  VOID: 'VOID',
  REVERTED: 'REVERTED',
  SESSION_START: 'SESSION_START',
});

export const SOURCES = Object.freeze({
  LOOTED: 'LOOTED',
  BUY: 'BUY',
  TRADE: 'TRADE',
  SYS: 'SYS',
});

export const STORAGE_PREFIX = 'arc_trade_tracker_v1';

export const STORAGE_KEYS = Object.freeze({
  metaforgeCache: `${STORAGE_PREFIX}_metaforge_cache`,
  metaforgeCacheTs: `${STORAGE_PREFIX}_metaforge_cache_ts`,
  stock: `${STORAGE_PREFIX}_stock`,
  audit: `${STORAGE_PREFIX}_audit`,
  liquidSeeds: `${STORAGE_PREFIX}_liquid_seeds`,
  allowCustomItems: `${STORAGE_PREFIX}_allow_custom_items`,
  staleThresholdDays: `${STORAGE_PREFIX}_stale_threshold_days`,
});
