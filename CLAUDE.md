# Stock Count System — CLAUDE.md

## Project Overview
ระบบนับสต็อกสินค้าแบบ single-page HTML สำหรับใช้งานใน browser โดยตรง ไม่มี backend
รองรับ 3 สาขา (SRC, KKL, SSS) แยกข้อมูลกันผ่าน Cloud Firestore
รองรับ multi-device: เครื่อง A สแกน → เครื่อง B ดึงข้อมูลจาก Cloud ได้

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
- **External (requires internet):** Firestore

## Login & Branch System
### Flow: เปิดโปรแกรม → เลือกสาขา → ใส่ PIN → ใช้งาน
```
DOMContentLoaded → showBranchSelector() → selectBranch(branch) → pinModal → verifyPin() → loadSession + restoreFromFirestore
```
- **ทุกครั้งที่เปิดโปรแกรม** ต้องเลือกสาขา + ใส่ PIN ก่อนเสมอ (ไม่มี auto-login)
- `_pinVerified` flag แยกว่าเป็นการเลือกครั้งแรก (ต้อง PIN) หรือสลับระหว่างใช้งาน

### Branch PINs
| สาขา | PIN |
|------|-----|
| SRC | 1234 |
| KKL | 4567 |
| SSS | 9999 |

### Branch Lock
- สลับสาขาระหว่างใช้งาน (ปุ่ม "เปลี่ยน") → `requestBranchChange()`
- ถ้ามี scanData ที่ non-pending → ต้องใส่ PIN ของสาขาปัจจุบันก่อนสลับ

### Branch Storage
- localStorage key แยกต่างหากต่อสาขา: `stockCountSession_SRC`, `stockCountSession_KKL`, `stockCountSession_SSS`
- Firestore document ID = ชื่อสาขา: `SRC`, `KKL`, `SSS` (ไม่มีวันที่ — ข้อมูลต่อเนื่องข้ามวัน)
- สลับสาขา → save สาขาเก่าก่อน (await) → clear state → โหลดสาขาใหม่

## ⚠️ ข้อควรระวังในการแก้ไขโค้ด

### 🚨 ห้ามข้อมูลที่สแกนไปแล้วหายเด็ดขาด
`state.scanData` คือหัวใจของระบบ — เก็บผลการนับทุก SKU ที่พนักงานสแกนไปแล้ว

**ห้ามทำสิ่งเหล่านี้โดยไม่ตั้งใจ:**
- `state.scanData.clear()` — ลบข้อมูลสแกนทั้งหมด (มีแค่ใน `selectBranch` และ `clearAllData` เท่านั้น)
- `state.scanData.delete(sku)` — ลบรายการ SKU เดี่ยว (มีแค่ใน `removeScanItem` เท่านั้น)
- เขียนทับ `state.scanData` ด้วย object ใหม่
- แก้ `saveSession()` / `loadSession()` โดยไม่ตรวจสอบว่า scanData ยังครบ

**ฟังก์ชันที่แตะ scanData ได้ (ต้องระวัง):**
```
handleBarcode()     → เพิ่ม/อัปเดต entry (ปกติ)
removeScanItem()    → ลบ entry เดี่ยว (ผ่านปุ่ม UI เท่านั้น)
evaluatePendingScans() → เปลี่ยน status scanning → pass/audit (ปกติ)
reEvaluateAuditItems() → เปลี่ยน status audit → pass (ปกติ)
selectBranch()      → clear ทั้งหมด (ตั้งใจ — สลับสาขา)
clearAllData()      → clear ทั้งหมด (ตั้งใจ — ต้องใส่ PIN)
loadSession()       → restore จาก localStorage (ตั้งใจ)
restoreFromFirestore() → restore จาก Firestore (ตั้งใจ)
```

**ก่อนแก้ไขโค้ดที่เกี่ยวข้องกับ scanData ต้องถามตัวเองว่า:**
> "ถ้าพนักงานสแกนสินค้าไปแล้ว 2,000 รายการ โค้ดนี้จะทำให้ข้อมูลหายไหม?"

---

## Key State & Data Flow

### State Object (`state`)
```js
state.r01Data       // [] — product master (SKU, productName, systemQty)
state.r05Data       // [] — barcode master (barcode → SKU mapping)
state.r16SalesMap   // Map<SKU, soldQty> — sales during count period (BASEQUANTITY) — บันทึก localStorage
state.r16RawMap     // Map<SKU, [{soldQty, tranDate}]> — raw R16 rows for TRANDATE filter — in-memory only
state.skuMap        // Map<SKU, {productName, systemQty, barcodes[]}>
state.barcodeMap    // Map<barcode, SKU>
state.skuDirectMap  // Map<SKU, {barcode, unitName}> — for scanning by SKU
state.scanData      // Map<SKU, {countedQty, status, timestamp, ...}>  ← ข้อมูลสำคัญที่สุด
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
soldQty = getSoldQtyBefore(sku, sd.timestamp)  ← กรองด้วย TRANDATE ≤ scan timestamp
effectiveCnt = countedQty + soldQty
effectiveCnt === systemQty → pass
effectiveCnt !== systemQty → audit
```
หมายเหตุ:
- บวก soldQty กลับเข้าไป (ของที่ขายไประหว่างนับต้องนับรวม)
- BASEQUANTITY (Col R) คือจำนวนที่แปลงเป็นหน่วยเล็กสุดแล้ว **ใช้โดยตรง ไม่ต้องคูณ QUANTITY**
- ตัวอย่าง: Alerest 10mg ขาย 5 แผง (10 เม็ด/แผง) → BASEQUANTITY=50, QUANTITY=5 → soldQty=50
- `sd.timestamp` = เวลาที่สแกน barcode ลง scan-input ครั้งล่าสุดของ SKU นั้น (ไม่ใช่เวลากด Confirm)
- `sd.timestamp` ใช้ **Local time (เวลาไทย)** — ใช้ `getFullYear/getMonth/...` ไม่ใช่ `toISOString()` (UTC)

### TRANDATE-based Filtering (getSoldQtyBefore)
```
R16 มีคอลัมน์ TRANDATE = วันเวลาขายจริงของ POS
getSoldQtyBefore(sku, scanTimestamp):
  ถ้า r16RawMap ว่าง หรือไม่มี scanTimestamp → fallback r16SalesMap (ยอดรวมทั้งหมด)
  ถ้า TRANDATE ≤ scanTimestamp → ขายก่อน/ระหว่างนับ → นับรวม
  ถ้า TRANDATE > scanTimestamp → ขายหลังนับ → ตัดออก
```
- `r16RawMap` เก็บ in-memory only ไม่บันทึก localStorage
- หลัง F5 โดยไม่โหลด R16 ใหม่ → r16RawMap ว่าง → fallback r16SalesMap อัตโนมัติ
- R16 ไม่มีคอลัมน์ TRANDATE → tranDate='' → นับรวมทั้งหมด (เดิม)
- TRANDATE column → **auto-detect จากชื่อ header** (ค้นหา `"TRANDATE"` case-insensitive) ไม่ได้ hardcode index
- TRANDATE format จริงจาก POS: `"D/M/YYYY HH:mm:ss"` (เดือน/วันอาจเป็น 1 หรือ 2 หลัก)
- `parseTranDate()` รองรับ: `D/M/YYYY`, `DD/MM/YYYY`, `D/M/YYYY HH:mm:ss`, `YYYY-MM-DD`, `YYYY-MM-DD HH:mm:ss`

### Workflow ที่รองรับ (สำคัญ)
```
✅ สแกนสินค้าให้ครบทุกชิ้นก่อน → โหลด R16 → กด Confirm
❌ สแกนบางส่วน → confirm → สแกนต่อ (ไม่รองรับ)
❌ สแกนครบแล้ว → สแกนซ้ำจากต้น (countedQty บวกสะสม จะผิด)
```

### R16 Re-evaluate
หลังโหลด R16 ใหม่ ระบบจะ re-evaluate item ที่เป็น `audit` อัตโนมัติ
ถ้าคำนวณใหม่แล้วตรง → เปลี่ยนเป็น `pass` (ฟังก์ชัน `reEvaluateAuditItems`)

## Key Functions

| Function | หน้าที่ |
|----------|---------|
| `verifyPin()` | ตรวจ PIN ตามสาขา → โหลดข้อมูล |
| `requestBranchChange()` | เช็ค scanData → ถ้ามี non-pending ต้องใส่ PIN |
| `selectBranch(branch)` | สลับสาขา (async — save ก่อน แล้ว clear แล้ว load) |
| `updateBranchDisplay()` | อัปเดต branch label + header border color |
| `rebuildMaps()` | สร้าง skuMap, barcodeMap จาก R01+R05 |
| `handleBarcode()` | ประมวลผล 1 barcode/SKU |
| `drainQueue()` | ประมวลผล scan queue แบบ batch |
| `evaluatePendingScans()` | เปรียบเทียบกับ systemQty → pass/audit |
| `reEvaluateAuditItems()` | re-evaluate audit items หลังโหลด R16 ใหม่ (ใช้ getSoldQtyBefore) |
| `parseTranDate(str)` | แปลง TRANDATE string → Date (รองรับ D/M/YYYY, DD/MM/YYYY, YYYY-MM-DD พร้อม/ไม่มีเวลา) |
| `getSoldQtyBefore(sku, ts)` | sum soldQty เฉพาะ TRANDATE ≤ ts (fallback r16SalesMap ถ้าไม่มีข้อมูล) |
| `appendScanRow()` | อัปเดต scanListMap (ไม่ render) |
| `rebuildScanListMap()` | สร้าง scanListMap จาก scanData (ข้าม pending) |
| `renderScanList()` | render scan list UI (max 100 rows) |
| `saveSession()` | บันทึก localStorage (branch-specific key) |
| `scheduleSave()` | debounce saveSession (400ms) |
| `syncToFirestore()` | sync ขึ้น Firestore เป็น JSON string (debounce 3s) |
| `syncMasterToFirestore()` | sync R01/R05 ขึ้น Firestore (แยก document) |
| `restoreFromFirestore(force)` | ดึงข้อมูลจาก Firestore (force=true ข้าม localStorage check) |
| `restoreMasterFromFirestore()` | ดึง R01/R05 จาก Firestore (fallback format เก่า) |
| `pullFromCloud()` | ปุ่ม "ดึงข้อมูล" → restoreFromFirestore(true) |
| `toggleAdmin()` | สลับ Administrator mode (PIN: 22190) |
| `backupSession()` | download JSON backup ลง local |
| `restoreSession(event)` | โหลด JSON backup กลับเข้าระบบ |
| `applyColWidths()` | set CSS grid-template-columns |

## Administrator Mode
- ปุ่ม "🔒 Administrator" → ใส่ PIN 22190 → เปิด/ปิด admin mode
- `_adminMode = true` → **ปิด Firestore sync** (syncToFirestore + syncMasterToFirestore ไม่ทำงาน)
- สำหรับทดสอบระบบโดยไม่กระทบข้อมูลจริงใน Firestore
- ข้อมูลยังบันทึกลง localStorage ปกติ

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
- `r16RawMap` (TRANDATE raw rows — in-memory only, ต้องโหลด R16 ใหม่หลัง F5)

## Firestore
**Collection:** `stock_sessions`
**Plan:** Spark (Free) — ไม่มีค่าใช้จ่าย, เกิน quota จะ block request (ไม่คิดเงิน)

### Documents per branch (เช่น SRC)
| Document ID | เก็บอะไร | Format |
|-------------|----------|--------|
| `SRC` | scanData, unknownScans, r16SalesMap, r16Loaded, scanListMap | `session_data_json` (JSON string) |
| `SRC_r01` | R01 product master data | `data_json` (JSON string) |
| `SRC_r05` | R05 barcode master data | `data_json` (JSON string) |

หมายเหตุ:
- เก็บเป็น **JSON string** เพื่อหลีกเลี่ยง Firestore index limit (40K entries/doc) และ document size limit (1MB)
- R01/R05 แยก document เพราะรวมกันเกิน 1MB
- ล้างข้อมูล (`clearAllData`) → ลบทั้ง localStorage + Firestore documents ทั้งหมด (PIN: 22190)

## Multi-Device Sync
```
เครื่อง A สแกน → scheduleSave (400ms) → saveSession → syncToFirestore (3s) → Firestore
เครื่อง B กดปุ่ม "☁️ ดึงข้อมูล" → pullFromCloud → restoreFromFirestore(true) → เห็นข้อมูล
```
หมายเหตุ: sync เป็น **one-way manual pull** — เครื่อง B ต้องกดดึงเอง ไม่ auto-sync

### Sync Logic (เปิดโปรแกรม / Branch Switch / Pull)
```
เปิดโปรแกรม:
  showBranchSelector → selectBranch → verifyPin → loadSession (localStorage)
  → restoreFromFirestore → rebuildScanListMap → render

สลับสาขา:
  clearTimeout timers → saveSession → await syncToFirestore
  → set newBranch → clear state → loadSession → restoreFromFirestore(force=true)

ปุ่ม "☁️ ดึงข้อมูล":
  restoreFromFirestore(force=true) → ข้าม localStorage check → ดึงจาก Firestore เสมอ
```

## File Parsing
- **CSV:** ตรวจ UTF-8 BOM → UTF-8 strict → fallback Windows-874 (Thai Excel)
- **XLSX:** อ่านผ่าน SheetJS `XLSX.read()` แบบ array buffer
- **R16.104:** Col R = BASEQUANTITY (จำนวนแปลงเป็นหน่วยเล็กสุดแล้ว) → ใช้เป็น soldQty โดยตรง
- **R16 TRANDATE:** auto-detect จาก header row (ค้นหาชื่อ "TRANDATE") → ใช้กรองยอดขายตาม timestamp

## Column Layout (scan-list)
```
Index: 0=SKU(98px)  1=Barcode(120px)  2=ProductName(flex)  3=Qty(65px)  4=Status(128px)  5=Action(105px)
```
ลาก resize ได้ ไม่เกิน container boundary

## Security
- **Branch PIN:** SRC=1234, KKL=4567, SSS=9999 (ใส่ทุกครั้งที่เปิดโปรแกรม)
- **Branch Lock:** มี scanData non-pending → ต้องใส่ PIN ถึงจะสลับสาขาได้
- **Administrator PIN:** 22190 (เปิด/ปิด admin mode)
- **ล้างข้อมูลทั้งหมด PIN:** 22190
- Firestore Security Rules: `allow read, write: if true` (open access, ไม่มี auth)
- Firebase API key เป็น public key ใช้ระบุ project เท่านั้น (ไม่ใช่ secret)

## Removed Features (dead code ที่ลบออกไปแล้ว)
- Overstock system (status, stats, popup column)
- Fail status
- Retry / Scanned By / Auditor columns (popup table)
- Supabase integration (แทนที่ด้วย Firestore)
- Cat A / mode system (catASkus, catSkuMap, state.mode)
- sold-badge ใน scan list
- Google Sheets integration (ลบทั้งหมด แทนที่ด้วยปุ่ม Administrator)

## Offline Support
- PapaParse, SheetJS → `libs/` folder (local)
- JetBrains Mono → `jbm400.ttf`, `jbm600.ttf` (local)
- **Firestore → ต้องใช้ internet**
- **ห้ามใช้ Incognito** — localStorage จะหายเมื่อปิด browser
- กรณี Firestore ไม่ได้ → ใช้ปุ่ม Backup/Restore สำรองข้อมูล
