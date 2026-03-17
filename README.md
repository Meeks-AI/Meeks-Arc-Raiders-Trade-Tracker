# Arc Raiders Trade Tracker

This repo hosts a single-page tracker app on GitHub Pages.

## Why the Metaforge sync fails on GitHub Pages

Some public APIs block browser requests from `github.io` origins (CORS). When that happens, the "Resync API" button in the browser cannot fetch Metaforge directly.

To keep GitHub Pages hosting (static) **and** still get fresh Metaforge data, this repo includes a GitHub Actions workflow that downloads items server-side and commits them into `data/metaforge-items.json`. Your site then loads that file from the same origin.

## Sync Metaforge items

- **Manual**: GitHub → Actions → `Sync Metaforge items` → Run workflow
- **Automatic**: runs daily (see `.github/workflows/sync-metaforge.yml`)

## Local development

Run a static server from the repo folder, then open the `http://localhost...` URL.

Examples:

```bash
python -m http.server 5173
```

or

```bash
npx serve
```

