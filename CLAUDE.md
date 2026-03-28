# Stock Count System — CLAUDE.md

## Project Overview
ระบบนับสต็อกสินค้าแบบ single-page HTML สำหรับใช้งานใน browser โดยตรง ไม่มี backend
รองรับ 3 สาขา (SRC, KKL, SSS) แยกข้อมูลกันผ่าน Cloud Firestore

## File Structure
```
StockCountFinal/
└── STOCK-COUNT-SYSTEM/
    ├── index.html          # ไฟล์หลัก — โค้ดทั้งหมดอยู่ที่นี่
    ├── jbm400.ttf          # JetBrains Mono Regular (offline font)
    ├── jbm600.ttf          # JetBrains Mono SemiBold (offline font)
    └── libs/
        ├── papaparse.min.js   # CSV parser (offline)
        └── xlsx.full.min.js   # Excel parser (offline)
```

## Tech Stack
- **UI:** Vanilla HTML/CSS/JS — ไม่มี framework
- **CSS Layout:** CSS Grid (scan list columns), Flexbox (general layout)
- **CSV Parsing:** PapaParse 5.4.1
- **Excel Parsing:** SheetJS (xlsx) 0.18.5
- **Font:** JetBrains Mono (local .ttf)
- **Storage:** localStorage (branch-specific key) + Cloud Firestore
- **Cloud:** Firebase Firestore (project: stock-count-1d6e7)
- **External (requires internet):** Firestore, Google Sign-In, Google Sheets API

## Branch System
```js
// สาขา hardcode ในปุ่ม modal HTML
let currentBranch = localStorage.getItem('selectedBranch') || '';
```
- เปิดครั้งแรก → modal เลือกสาขา
- localStorage key แยกต่างหากต่อสาขา: `stockCountSession_SRC`, `stockCountSession_KKL`, `stockCountSession_SSS`
- Firestore document ID = ชื่อสาขา: `SRC`, `KKL`, `SSS` (ไม่มีวันที่ — ข้อมูลต่อเนื่องข้ามวัน)
- สลับสาขา → save สาขาเก่าก่อน (await) → clear state → โหลดสาขาใหม่

## Key State & Data Flow

### State Object (`state`)
```js
state.r01Data       // [] — product master (SKU, productName, systemQty)
state.r05Data       // [] — barcode master (barcode → SKU mapping)
state.r16SalesMap   // Map<SKU, soldQty> — sales during count period
state.skuMap        // Map<SKU, {productName, systemQty, barcodes[]}>
state.barcodeMap    // Map<barcode, SKU>
state.skuDirectMap  // Map<SKU, {barcode, unitName}> — for scanning by SKU
state.scanData      // Map<SKU, {countedQty, status, timestamp, ...}>
state.unknownScans  // [] — barcodes not found in system
```

### Scan Flow
```
handleScanKey → processScan → drainQueue → handleBarcode → appendScanRow
                                                         ↓
                                               renderScanList (1x per scan)
```

### Status Values
- `pending` — ยังไม่ได้สแกน
- `scanning` — สแกนแล้ว รอยืนยัน
- `pass` — ยืนยันแล้ว จำนวนตรง
- `audit` — ยืนยันแล้ว จำนวนไม่ตรง (ส่ง Audit)
- `audit_check` — Auditor ยืนยันแล้ว
- `unknown` — ไม่พบใน R01/R05

### Confirm Logic (evaluatePendingScans)
```
effectiveCnt = countedQty + soldQty (R16)
effectiveCnt === systemQty → pass
effectiveCnt !== systemQty → audit
```
หมายเหตุ: บวก soldQty กลับเข้าไป (ของที่ขายไประหว่างนับต้องนับรวม)

### R16 Re-evaluate
หลังโหลด R16 ใหม่ ระบบจะ re-evaluate item ที่เป็น `audit` อัตโนมัติ
ถ้าคำนวณใหม่แล้วตรง → เปลี่ยนเป็น `pass` (ฟังก์ชัน `reEvaluateAuditItems`)

## Key Functions

| Function | หน้าที่ |
|----------|---------|
| `rebuildMaps()` | สร้าง skuMap, barcodeMap จาก R01+R05 |
| `handleBarcode()` | ประมวลผล 1 barcode/SKU |
| `drainQueue()` | ประมวลผล scan queue แบบ batch |
| `evaluatePendingScans()` | เปรียบเทียบกับ systemQty → pass/audit |
| `reEvaluateAuditItems()` | re-evaluate audit items หลังโหลด R16 ใหม่ |
| `appendScanRow()` | อัปเดต scanListMap (ไม่ render) |
| `renderScanList()` | render scan list UI (max 100 rows) |
| `saveSession()` | บันทึก localStorage (branch-specific key) |
| `scheduleSave()` | debounce saveSession (400ms) |
| `syncToFirestore()` | sync ขึ้น Firestore (debounce 3s) |
| `restoreFromFirestore(force)` | ดึงข้อมูลจาก Firestore (force=true ข้าม localStorage check) |
| `selectBranch(branch)` | สลับสาขา (async — save ก่อน แล้ว clear แล้ว load) |
| `backupSession()` | download JSON backup ลง local |
| `restoreSession(event)` | โหลด JSON backup กลับเข้าระบบ |
| `applyColWidths()` | set CSS grid-template-columns |

## Performance Notes
- `renderScanList()` ถูกเรียก **1 ครั้ง** ต่อสแกน (ไม่เรียกใน appendScanRow)
- `applyColWidths()` เรียกเฉพาะใน `_initColDefaults()` และ drag resize
- `invalidatePopupRowsCache()` เรียกเฉพาะเมื่อ popup เปิดอยู่
- `saveSession()` debounce 400ms
- `syncToFirestore()` debounce 3000ms
- `scheduleStats()` / `scheduleRender()` debounce 80ms
- `SCAN_LIST_MAX = 100` — แสดงสูงสุด 100 รายการล่าสุด
- `POPUP_MAX_RENDER_ROWS = 500`

## localStorage
**Key:** `stockCountSession_{branch}` เช่น `stockCountSession_SRC`
**ขนาดประมาณ:** ~1.5–2 MB สำหรับ 3,000 SKU (browser limit ~5 MB)

ฟิลด์ที่ **ไม่บันทึก** ลง localStorage (ประหยัด space):
- `scans[]`, `scannedBy`, `auditor`, `retries` ใน scanData
- `r16Data` (raw rows)

## Firestore
**Collection:** `stock_sessions`
**Document ID:** ชื่อสาขา (`SRC`, `KKL`, `SSS`) — session เดียวต่อสาขา ต่อเนื่องข้ามวัน
**Fields:** `session_data`, `updated_at`

ข้อมูลที่เก็บใน Firestore (ไม่รวม r01Data/r05Data เพราะขนาดใหญ่):
- `scanData`, `unknownScans`, `r16SalesMap`, `r16Loaded`, `scanListMap`

ล้างข้อมูล (`clearAllData`) → ลบทั้ง localStorage + Firestore document พร้อมกัน

## Sync Logic (F5 / Branch Switch)
```
F5 refresh:
  loadSession (localStorage) → มี scanData → skip Firestore restore
  loadSession (localStorage) → ไม่มี scanData → restoreFromFirestore

สลับสาขา:
  clearTimeout timers → saveSession → await syncToFirestore
  → set newBranch → clear state → loadSession → restoreFromFirestore(force=true)
```

## File Parsing
- **CSV:** ตรวจ UTF-8 BOM → UTF-8 strict → fallback Windows-874 (Thai Excel)
- **XLSX:** อ่านผ่าน SheetJS `XLSX.read()` แบบ array buffer

## Column Layout (scan-list)
```
Index: 0=SKU(98px)  1=Barcode(120px)  2=ProductName(flex)  3=Qty(65px)  4=Status(128px)  5=Action(105px)
```
ลาก resize ได้ ไม่เกิน container boundary

## Removed Features (dead code ที่ลบออกไปแล้ว)
- Overstock system (status, stats, popup column)
- Fail status
- Retry / Scanned By / Auditor columns (popup table)
- Supabase integration (แทนที่ด้วย Firestore)
- Cat A / mode system (catASkus, catSkuMap, state.mode)
- sold-badge ใน scan list

## Offline Support
- PapaParse, SheetJS → `libs/` folder (local)
- JetBrains Mono → `jbm400.ttf`, `jbm600.ttf` (local)
- **Firestore / Google Sign-In / Google Sheets API → ต้องใช้ internet**
- **ห้ามใช้ Incognito** — localStorage จะหายเมื่อปิด browser
- กรณี Firestore ไม่ได้ → ใช้ปุ่ม Backup/Restore สำรองข้อมูล
