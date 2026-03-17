const METAFORGE_URL = 'https://metaforge.app/api/arc-raiders';

async function fetchMetaforgeAll() {
  const out = [];
  let page = 1;
  let hasMore = true;
  const limit = 100;
  const maxPages = 200;

  while (hasMore) {
    if (page > maxPages) {
      throw new Error(`Safety stop: exceeded maxPages (${maxPages}).`);
    }

    const url = `${METAFORGE_URL}/items?page=${page}&limit=${limit}&minimal=true`;
    const res = await fetch(url, {
      headers: { accept: 'application/json' },
    });

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`Metaforge HTTP ${res.status} ${res.statusText}: ${text.slice(0, 300)}`);
    }

    const json = await res.json();
    const data = Array.isArray(json?.data) ? json.data : [];
    out.push(...data);

    hasMore = Boolean(json?.pagination?.hasNextPage);
    page++;
  }

  return out;
}

async function main() {
  const { writeFile, mkdir } = await import('node:fs/promises');
  const outPath = new URL('../data/metaforge-items.json', import.meta.url);
  const outDir = new URL('../data/', import.meta.url);

  await mkdir(outDir, { recursive: true });

  const items = await fetchMetaforgeAll();
  const payload = {
    updatedAt: new Date().toISOString(),
    count: items.length,
    data: items,
  };
  await writeFile(outPath, JSON.stringify(payload, null, 2), 'utf8');
}

await main();

