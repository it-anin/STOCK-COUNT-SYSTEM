# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Running the App

No build step. Open `index.html` directly in a browser, or serve via any static HTTP server:

```bash
npx serve .
# or
python -m http.server 8080
```

The app is a PWA installable via the browser. The Service Worker (`sw.js`) caches static assets with cache-first strategy and uses network-first for HTML.

## Architecture

The entire application is a **single `index.html` file** containing all HTML structure, CSS (with CSS variables for theming), and JavaScript (~1700+ lines). There is no build system, no framework, and no module bundler.

**External dependencies** (loaded via CDN/local):
- `libs/papaparse.min.js` — CSV parsing
- `libs/xlsx.full.min.js` — Excel read/write
- Firebase Firestore v10.12.0 (compat CDN) — cloud sync

### Central State Object

All application data lives in a single `state` object:

```js
state = {
  productMasterData, productMasterMap,   // Product catalog (all branches)
  r01Data,                               // Inventory quantities from R01.102
  r05Data,                               // Barcode mapping from R05.106
  r16Data, r16SalesMap, r16RawMap,       // Sales-during-count from R16.104
  skuMap,      // SKU → { productName, systemQty, barcodes[] }
  barcodeMap,  // barcode → SKU
  skuDirectMap,// SKU → { barcode, unitName } (smallest-unit barcode)
  scanData,    // Map<SKU, { countedQty, status, timestamp, ... }>
  unknownScans // items scanned but not in system
}
```

`scanListMap` is a separate `Map` used only for rendering the live scan list UI (last 100 entries). It is rebuilt from `state.scanData` via `rebuildScanListMap()`.

### Data Flow

1. **Upload files** → `loadR01()` / `loadR05()` / `loadProductMaster()` → `rebuildMaps()` builds `skuMap`, `barcodeMap`, `skuDirectMap` and initialises `scanData` with `pending` entries for every known SKU.

2. **Scan** → `handleBarcode()` → looks up in `barcodeMap` first, then `skuDirectMap` (for SKU direct scan) → accumulates `countedQty` in `state.scanData`; status set to `scanning`.

3. **Upload R16.104** → `loadR16()` → builds `r16SalesMap` (SKU → total sold qty) and `r16RawMap` (SKU → rows with tranDate) for time-filtered deduction.

4. **Confirm** → `evaluatePendingScans()` → for each `scanning` item: `effectiveCnt = countedQty + getSoldQtyBefore(sku, timestamp)`, compare with `systemQty` → set `pass` or `audit`.

5. **Audit resolution** → user clicks "ยืนยันจำนวน" in the scan row → status changes to `audit_check`.

### Status Lifecycle

```
pending → scanning → pass
                   → audit → audit_check
```
`unknown` is a parallel track for barcodes not found in any reference file.

### Branch / Auth System

Three branches: **SRC**, **KKL**, **SSS**. Each has its own localStorage key (`stockCountSession_${branch}`) and separate Firestore namespace.

- Branch PINs are hardcoded in `BRANCH_PINS` object.
- Admin PIN `22190` / `CLEAR_PIN` enables admin mode: bypasses the 21:00 upload restriction for R01.102, shows hidden upload panels (Product Master, R05), and **disables Firestore sync** (local only).
- R01.102 upload is time-gated to after 21:00 in normal mode.

### Persistence Layers

| Layer | Key/Path | When written |
|---|---|---|
| localStorage | `stockCountSession_${branch}` | Every `saveSession()`, debounced 400 ms |
| Firestore `stock_sessions/${branch}` | Scan data | 3 s after localStorage write |
| Firestore `stock_sessions/${branch}_r01/r05` | R01/R05 master data | After file upload |
| Firestore `stock_sessions/global_pm` | Product Master | After PM upload; real-time listener on all devices |
| Firestore `stock_history/${branch}_${date}` | Historical count records | On "เริ่มนับใหม่" |
| JSON file (download) | backup | On "Backup" button |

`global_pm` is **shared across all branches** with an `onSnapshot` real-time listener (`startProductMasterListener()`). All other data is per-branch.

### R16.104 TRANDATE Filter Logic

`getSoldQtyBefore(sku, scanTimestamp)` compares each R16 sale's `TRANDATE` against the item's scan timestamp:
- `TRANDATE <= scanTimestamp` → sale happened before/during count → **include** in soldQty (add back to countedQty)
- `TRANDATE > scanTimestamp` → sale happened after count → **exclude**
- `TRANDATE missing/unparseable` → **exclude** (conservative — avoids false Audit)

This relies on `r16RawMap` (SKU → `[{soldQty, tranDate}]`), built during `loadR16()`. **`r16RawMap` is NOT persisted** to localStorage or Firestore — it only exists in memory for the current session. After page refresh, `getSoldQtyBefore` falls back to `r16SalesMap` (no time filter). This is acceptable because statuses are already saved after Confirm; re-evaluation only happens if R16 is re-uploaded (which rebuilds `r16RawMap`).

TRANDATE column is auto-detected from R16 header row by matching column name `TRANDATE` (case-insensitive). If not found, `tranDate = ''` for all rows. Check browser Console for `[R16] TRANDATE col index:` to verify detection.

`parseTranDate()` supports these formats:
- `DD/MM/YYYY H:mm[:ss] [AM/PM]` — Thai POS slash format
- `DD-MM-YY H:mm[:ss] [AM/PM]` — Thai POS dash format e.g. `25-04-26 8:07`
- `DD-MM-YYYY H:mm[:ss] [AM/PM]` — e.g. `25-04-2026 8:38:50 AM`
- `YYYY-MM-DD HH:mm:ss` — ISO format

AM/PM is handled correctly (12 AM → 0:00, 1 PM → 13:00, etc.).

R01.102 is uploaded once at 21:00 (time-gated in normal mode). SystemQty represents stock as of that snapshot. R16.104 covers sales from after the R01 snapshot until upload time. The formula: `effectiveCnt = countedQty + soldQty_before_scan` compared against `systemQty`.

### CSV/Excel Parsing

`parseFile()` handles `.csv` and `.xlsx`/`.xls`. For CSV, it auto-detects UTF-8 BOM → UTF-8 → Windows-874 (Thai Excel default) encoding.

Column mappings (zero-indexed, skip row 0 header):
- **R01.102**: Col E (index 4)=SKU, F (5)=ProductName, G (6)=SystemQty; rows with qty≤0 are skipped. Re-uploading clears previous data (`state.r01Data = []` first).
- **R05.106**: Col A (0)=Barcode, E (4)=SKU, G (6)=unitName, H (7)=unitMultiplier.
- **R16.104**: Col C (2) must start with `ORCM` or `OCTM`; Col O (14)=Barcode; Col R (17)=BASEQUANTITY (already converted to smallest unit); Col X (23)=SKU; TRANDATE column auto-detected from header row (row 0).

### Scan Input Formats

The scan input accepts comma-separated values:
```
barcode                    → qty defaults to 1
barcode,qty
location,barcode,qty
SKU                        → resolves to smallest-unit barcode
SKU,qty
location,SKU,qty
```

### Rendering

- All renders are debounced (80 ms for popup table, 60 ms for scan list, 400 ms for save).
- Scan list renders last **100** entries (`SCAN_LIST_MAX`).
- Popup table renders at most **500** rows (`POPUP_MAX_RENDER_ROWS`).
- `popupBaseRowsCache` caches the full popup row list; invalidated by `invalidatePopupRowsCache()` on any state change. Call this whenever `state.scanData` or `state.unknownScans` changes.
- `patchScanRow(key)` does targeted in-place DOM update for a single row without full re-render; used during batch scans.

### Responsive / Device Behaviour

- ≥820 px: two-column layout (left upload panel + center scan panel).
- ≤820 px: condensed column widths, reduced padding.
- ≤600 px (PDA/phone): single column, left panel hidden, Confirm button hidden (confirmation is done on desktop after 21:00). Page height is locked (`overflow:hidden`) and scan list body fills remaining height.
- Portrait orientation lock via `screen.orientation.lock('portrait')`.
- Scan input auto-refocuses on `visibilitychange` and on any click outside interactive elements.

## Firebase Config

The Firebase project credentials (`FIREBASE_CONFIG`) are hardcoded in `index.html`. The project is `stock-count-1d6e7`. Firestore is the only Firebase service used.
