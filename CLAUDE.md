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
  productMasterData, productMasterMap,                         // Product catalog (all branches)
  r01Data,                                                     // Inventory quantities from R01.102
  r05Data,                                                     // Barcode mapping from R05.106
  r16Data, r16SalesMap, r16RawMap,                             // Sales-during-count (ORCM/OCTM) from R16.104
  r16InboundMap, r16InboundRawMap,                             // Inbound-during-count (OTFB/ORTS/OTFI) from R16.104
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

3. **Upload R16.104** → `loadR16()` → builds `r16SalesMap` + `r16RawMap` (sales: ORCM/OCTM) and `r16InboundMap` + `r16InboundRawMap` (inbound: OTFB/ORTS/OTFI) for time-filtered adjustment.

4. **Confirm** → `evaluatePendingScans()` → for each `scanning` item: `effectiveCnt = countedQty + getSoldQtyBefore(sku, timestamp) - getInboundQtyBefore(sku, timestamp)`, compare with `systemQty` → set `pass` or `audit`.

5. **Audit resolution** → user clicks "ยืนยันจำนวน" in the scan row → status changes to `audit_check`.

### Status Lifecycle

```
pending → scanning → pass
                   → audit → (pharmacist re-scan pass)  → pass
                           → (pharmacist re-scan fail)  → stock_adjustment
```
`unknown` is a parallel track for barcodes not found in any reference file.

`audit_check` still exists in the codebase for compatibility but is no longer produced by the re-audit flow (pharmacist re-audit goes directly to `pass` or `stock_adjustment`).

**Stat card — Audit:**
- Large number: items still at `audit` (waiting for pharmacist).
- Sub-text `got / need`: pharmacist-checked items (`audit_check` + `stock_adjustment`) over total audit items ever flagged. Hidden when `auditTotal === 0`.

### Auto-Update (Service Worker)

When a new version is deployed, the Service Worker (`sw.js`) installs immediately via `skipWaiting()`. On `controllerchange`:
1. Current `currentUser` + `currentRole` are saved to `sessionStorage` (`_autoUpdateUser`, `_autoUpdateRole`, `_autoUpdate` flag).
2. A brief blue banner "🔄 กำลังอัพเดทเวอร์ชันใหม่..." appears for 1.5 s then `window.location.reload()`.
3. On `DOMContentLoaded` after reload: if `_autoUpdate` flag is set **and** `currentBranch` + user are known, skip branch selector / PIN modal / employee selector entirely and call `initAfterLogin()` directly.
4. If flag is set but user was not logged in (e.g. update fired during branch selection), falls back to normal `showBranchSelector()` flow.

### Branch / Auth System

Three branches: **SRC**, **KKL**, **SSS**. Each has its own localStorage key (`stockCountSession_${branch}`) and separate Firestore namespace.

- Branch PINs are hardcoded in `BRANCH_PINS` object.
- Admin PIN `22190` / `CLEAR_PIN` enables admin mode: bypasses the 21:00 upload restriction for R01.102, shows hidden upload panels (Product Master, R05), and **disables Firestore sync** (local only).
- R01.102 upload is time-gated to after 21:00 in normal mode.

### Employee Profile System

After branch PIN is verified, an employee selector modal appears. Two roles:

| Role | Branches / Names |
|---|---|
| **เภสัช** (pharmacist) | SRC: เภอ๊อฟ / KKL: เภออด / SSS: เภเบส |
| **ผู้ช่วยเภสัช** (assistant) | SRC: ก้า, กิฟ, สุ่ย, นิกกี้ / KKL: แตงโม, ทราย / SSS: ออย, ฟ้าใส |

Profiles are defined in `EMPLOYEE_PROFILES` constant. Selected employee is stored in `currentUser` (string) and `currentRole` (`'pharmacist'` | `'assistant'`). The header displays the active user. On branch switch, `currentUser`/`currentRole` are cleared and the selector re-appears.

**Pharmacist re-audit flow** (`openReauditModal`, `handleReauditScan`, `confirmReaudit`):
1. In the popup table, `audit` rows show a **ตรวจซ้ำ** button only when `currentRole === 'pharmacist'`.
2. Clicking opens a re-audit modal with a dedicated scan input.
3. Pharmacist scans barcode(s); `_reauditQty` accumulates using `unitMultiplier`.
4. On confirm: if `_reauditQty === systemQty` → status `pass`; otherwise → status `stock_adjustment`.
5. `sd.auditor` is set to `currentUser`.

Pharmacy assistants have no access to re-audit; they scan normally via the main scan input.

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

### DEL Items

When both Product Master and R01 are loaded, SKUs present in R01 but absent from Product Master are flagged `isDel: true` in `skuMap`. They are shown in the popup table with a red **DEL** badge and are selectable via the **🗑️ DEL** filter button in the popup toolbar. They participate in scanning and evaluation normally.

### Column Resizing

The scan list header columns are drag-resizable via `initColResize()`. Widths are stored in `_colWidths[6]` and applied via `applyColWidths()` which sets `grid-template-columns` on every `.scan-list-header` and `.scan-row` element. The name column (index 2) is computed as the remaining space.

### History Feature

"📅 ประวัติ" button opens a history popup (`openHistoryPopup`). It reads `stockCountHistory_${branch}` from localStorage (up to 60 entries). Each entry is created by "เริ่มนับใหม่" and saved to `stock_history/${branch}_${date}` in Firestore. The popup has a date selector, renders the historical scan table, and supports Export Excel (`exportHistoryExcel`) — output: `history_${branch}_${date}.xlsx`.

### Export Excel (Audit Only)

`exportExcel()` exports only items with status `audit` or `stock_adjustment` — not all scanned items. Output file: `audit_${date}.xlsx` with columns: SKU, Barcode, ProductName, SystemQty, CountedQty, Status, Timestamp, Audit Status.

### 2-Minute Scan Gap Reset

In `handleBarcode()`, if the same SKU is scanned again after more than 2 minutes since its last `timestamp`, `countedQty` is reset to 0 and a warning toast is shown. This prevents accidental accumulation across separate counting sessions.

### Inline QTY Edit in Popup Table

In the popup table, `countedQty` is editable inline (`updatePopupQty`) when `systemQty > 100` AND status is `pending` or `scanning`. If the item was `pending`, editing promotes it to `scanning` and adds it to `scanListMap`. Editing is blocked for `pass`, `audit`, `audit_check`, and `stock_adjustment`.

### Product Master Col D Filter

In `loadProductMaster()`, rows where Col D (index 3) equals `P` or `REVIEW` (case-insensitive) are skipped. This filters out discontinued or under-review products from the PM import.

### Clear Scan List vs Clear Data

The **✕ Clear** button calls `clearScanList()` which only clears `scanListMap` (the live scan list UI). It does NOT reset `state.scanData` — counted quantities and statuses are preserved. To fully reset a scanned item, use the **✕** button on individual rows (`removeScanItem`), which resets that SKU's `scanData` entry back to `pending`.

### Audit Verify Panel (เภสัชเท่านั้น)

A panel card below "Product List" in the left panel, visible only when `currentRole === 'pharmacist'`. Badge shows total count of `audit` + `stock_adjustment` items combined.

**Popup has two filter tabs:**

**⚠️ Audit tab** — shows items with `status === 'audit'`:
- Columns: `#` / `SKU` / `Barcode` / `Product Name` / `Count Qty` (assistant's count = `sd.countedQty`) / `Recheck` (pharmacist's accumulated scan) / `Status` / `Timestamp` / `ยืนยัน`
- Pharmacist scans barcode in the scan input (`handleAuditVerifyScan`) → accumulates qty in `_avMap: Map<SKU, number>`
- When pharmacist clicks **✓ ยืนยัน** (`confirmAuditVerifyItem`):
  - `pharmacistQty === systemQty` → `status: 'pass'`
  - `pharmacistQty !== systemQty` → `status: 'stock_adjustment'`
  - Saves `sd.recheckQty = pharmacistQty`, `sd.auditor = currentUser`, `sd.timestamp` = pharmacist's verification time (overwrites assistant's timestamp)

**🔴 Stock Adj tab** — shows items with `status === 'stock_adjustment'`:
- Columns: `#` / `SKU` / `Barcode` / `Product Name` / `Sys Qty` (`si.systemQty`) / `Recheck Qty` (`sd.recheckQty` if saved, else `sd.countedQty`) / `Diff` / `Timestamp`
- `Diff = recheckQty − systemQty`: ▼ X สีแดง (ขาด/ติดลบ) หรือ ▲ X สีส้ม (เกิน)
- No scan input action in this tab — read-only view

`_avFilter` (`'audit'` | `'stock_adj'`) controls which tab is active. Resets to `'audit'` every time the popup is opened. Filter badge counts are updated on every `renderAuditVerifyTable()` call.

### Scan List QTY Masking

The QTY column in the live scan list is intentionally masked to prevent counter bias:
- **countedQty ≤ 100** → displays `—` (hidden)
- **countedQty > 100** → displays actual number (as a warning to re-check)

This applies to both `renderScanList()` (full re-render) and `patchScanRow()` (in-place patch). When qty > 100 and status is `scanning`, the editable inline input is shown as normal; otherwise the cell shows `—` and is not editable.

### Responsive / Device Behaviour

- ≥820 px: two-column layout (left upload panel + center scan panel).
- ≤820 px: condensed column widths, reduced padding.
- ≤600 px (PDA/phone): single column, left panel hidden, Confirm button hidden (confirmation is done on desktop after 21:00). Page height is locked (`overflow:hidden`) and scan list body fills remaining height.
- Portrait orientation lock via `screen.orientation.lock('portrait')`.
- Scan input auto-refocuses on `visibilitychange` and on any click outside interactive elements.

## Firebase Config

The Firebase project credentials (`FIREBASE_CONFIG`) are hardcoded in `index.html`. The project is `stock-count-1d6e7`. Firestore is the only Firebase service used.
