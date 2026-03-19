const METAFORGE_URL = 'https://metaforge.app/api/arc-raiders';

async function fetchAllPages(url, limitParam = 100, maxPages = 200) {
  const out = [];
  let page = 1;
  let hasMore = true;

  while (hasMore) {
    if (page > maxPages) throw new Error(`Safety stop: exceeded maxPages (${maxPages}).`);

    const res = await fetch(`${url}${url.includes('?') ? '&' : '?'}page=${page}&limit=${limitParam}`, {
      headers: { accept: 'application/json' },
    });

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`HTTP ${res.status} ${res.statusText}: ${text.slice(0, 300)}`);
    }

    const json = await res.json();
    out.push(...(json.data || []));
    hasMore = Boolean(json?.pagination?.hasNextPage);
    page++;
  }

  return out;
}

async function main() {
  const { writeFile, mkdir } = await import('node:fs/promises');
  const outDir = new URL('../data/', import.meta.url);
  await mkdir(outDir, { recursive: true });

  // Items
  console.log('Fetching items...');
const items = await fetchAllPages(`${METAFORGE_URL}/items`);
  await writeFile(
    new URL('../data/metaforge-items.json', import.meta.url),
    JSON.stringify({ updatedAt: new Date().toISOString(), count: items.length, data: items }, null, 2),
    'utf8',
  );
  console.log(`  ${items.length} items saved.`);

  // Quests
  console.log('Fetching quests...');
  try {
    const quests = await fetchAllPages(`${METAFORGE_URL}/quests`);
    await writeFile(
      new URL('../data/metaforge-quests.json', import.meta.url),
      JSON.stringify({ updatedAt: new Date().toISOString(), count: quests.length, data: quests }, null, 2),
      'utf8',
    );
    console.log(`  ${quests.length} quests saved.`);
  } catch (e) {
    console.warn(`  Quests fetch failed (non-fatal): ${e.message}`);
  }
}

await main();
