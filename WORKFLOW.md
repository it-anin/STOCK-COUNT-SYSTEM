# ขั้นตอนการทำงานของระบบนับสต็อก (Stock Count System)

---

## ภาพรวม

ระบบนับสต็อกเป็น PWA (Progressive Web App) ไฟล์เดียว (`index.html`) ไม่มี build step  
ทำงานร่วมกัน 3 สาขา: **SRC / KKL / SSS** ผ่าน Firebase Firestore

---

## 1. เริ่มต้นใช้งาน (Login Flow)

```
เปิดเบราว์เซอร์
    ↓
เลือกสาขา (SRC / KKL / SSS)
    ↓
ใส่ PIN สาขา
    ↓
เลือกผู้ใช้งาน (เภสัช / ผู้ช่วยเภสัช)
    ↓
โหลดข้อมูลจาก localStorage + Firestore อัตโนมัติ
```

**หมายเหตุ:**
- PIN แต่ละสาขาถูก hardcode ใน `BRANCH_PINS`
- สิทธิ์การทำงานขึ้นกับ role: เภสัชสามารถกด **ตรวจซ้ำ** ได้ ผู้ช่วยทำไม่ได้
- เมื่อสลับสาขา ต้องใส่ PIN ใหม่และเลือกผู้ใช้ใหม่เสมอ

---

## 2. อัพโหลดไฟล์ข้อมูล

ต้องอัพโหลดตามลำดับ **ก่อนเริ่มนับ**:

### 2.1 R01.102 — จำนวนสินค้า (System Qty)
- อัพโหลดได้หลัง **21:00** เท่านั้น (ปกติ) หรือเข้า Admin Mode เพื่อข้ามเงื่อนไขเวลา
- อ่าน: Col E = SKU, Col F = ชื่อสินค้า, Col G = SystemQty
- ข้ามแถวที่ qty ≤ 0
- sync ขึ้น Firestore อัตโนมัติหลังโหลด (`stock_sessions/${branch}_r01`)

### 2.2 R05.106 — Barcode สินค้า
- ซ่อนอยู่ในโหมดปกติ — แสดงเฉพาะเมื่อเข้า **Admin Mode**
- อ่าน: Col A = Barcode, Col E = SKU, Col G = unitName, Col H = unitMultiplier
- sync ขึ้น Firestore อัตโนมัติ (`stock_sessions/${branch}_r05`)

### 2.3 Product Master (ตัวเลือก — Admin เท่านั้น)
- แหล่งชื่อสินค้าหลัก ใช้แทนชื่อจาก R01
- อ่าน: Col A = SKU, Col B = ชื่อสินค้า, Col D = สถานะ (ข้ามถ้าเป็น `P` หรือ `REVIEW`)
- shared ทุกสาขา — sync ผ่าน `stock_sessions/global_pm` พร้อม real-time listener
- SKU ที่อยู่ใน R01 แต่ไม่อยู่ใน PM จะถูก flag เป็น **DEL**

### 2.4 R16.104 — ยอดขาย/รับเข้าระหว่างนับ
- อัพโหลดก่อนกด Confirm เสมอ (ปุ่ม Confirm จะ disabled จนกว่าจะโหลด R16)
- อ่าน Col C เพื่อแยกประเภท:
  - `ORCM` / `OCTM` → **ยอดขาย** → บวกกลับเข้า countedQty ตอน Confirm
  - `OTFB` / `ORTS` / `OTFI` → **ยอดรับเข้า** → หักออกจาก countedQty ตอน Confirm
- ตรวจจับ TRANDATE column อัตโนมัติจาก header row เพื่อ filter ตามเวลาสแกน

---

## 3. สร้าง Map ภายใน (rebuildMaps)

หลังโหลด R01 + R05 ระบบสร้าง:

| Map | คีย์ | ค่า |
|---|---|---|
| `skuMap` | SKU | `{ productName, systemQty, barcodes[], isDel }` |
| `barcodeMap` | barcode | SKU |
| `skuDirectMap` | SKU | `{ barcode, unitName }` (barcode หน่วยเล็กสุด) |
| `scanData` | SKU | `{ countedQty:0, status:'pending', ... }` |

ทุก SKU เริ่มต้นด้วย status `pending`

---

## 4. การสแกนสินค้า

### รูปแบบที่รองรับ
```
barcode                  → qty = 1
barcode,qty
location,barcode,qty
SKU                      → ระบบหา barcode หน่วยเล็กสุดให้
SKU,qty
location,SKU,qty
```

### ลำดับการทำงาน (handleBarcode)
```
รับ input → parseScanLine()
    ↓
ค้นใน barcodeMap → พบ SKU?
    ├─ ไม่พบ → ค้นใน skuDirectMap (scan SKU โดยตรง)?
    │       ├─ ไม่พบ → บันทึกเป็น unknownScans (status: unknown)
    │       └─ พบ → แปลง SKU → barcode หน่วยเล็กสุด
    └─ พบ → ตรวจสอบ status ปัจจุบัน
            ├─ pass/audit/stock_adjustment → แสดงใน scan list แต่ไม่เปลี่ยน qty
            └─ pending/scanning → สะสม countedQty += qty × unitMultiplier
                                  status → 'scanning'
```

**กฎพิเศษ — Scan Gap 2 นาที:**  
ถ้าสแกน SKU เดิมห่างกันเกิน 2 นาที → modal เตือน "หยุดสแกนเกิน 2 นาที" แสดง `นับเดิม → 0`  
กด **ยืนยัน — เริ่มนับใหม่** → `countedQty` รีเซ็ตเป็น **0** และ `scans` ถูกล้าง  
barcode ที่ trigger modal **ไม่ถูกนับ** — ต้องสแกนใหม่ตั้งแต่ต้น

**PDA Auto-Submit (Debounce 200ms):**  
`handleScanInput` มี debounce 200ms รองรับเครื่อง PDA ที่ไม่ส่ง Enter หลัง barcode  
เมื่อ PDA หยุดส่งตัวอักษรครบ 200ms ระบบ submit อัตโนมัติ — ป้องกัน barcode เชื่อมต่อกันจนขึ้น Unknown

### การ render scan list
- ใช้ `scanListMap` แสดงผล (แยกจาก `scanData`)
- แสดงสูงสุด **100** รายการล่าสุด
- QTY ถูกซ่อน (`—`) ถ้า countedQty ≤ 100 เพื่อป้องกัน bias
- ปุ่ม **✕** บนแถว `scanning` รีเซ็ต SKU นั้นกลับเป็น `pending`
- ปุ่ม **✕ Clear** ล้างแค่ scan list UI (`scanListMap`) — ข้อมูล `scanData` ยังอยู่

---

## 5. Confirm — ประเมินผล (evaluatePendingScans)

กดปุ่ม **✓ Confirm** → ระบบประเมินทุก SKU ที่ status = `scanning`:

```
effectiveCnt = countedQty
             + getSoldQtyBefore(sku, scanTimestamp)   ← ยอดขายก่อน/ระหว่างสแกน
             - getInboundQtyBefore(sku, scanTimestamp) ← ยอดรับเข้าก่อน/ระหว่างสแกน

effectiveCnt == systemQty → status: 'pass'
effectiveCnt != systemQty → status: 'audit'
```

**TRANDATE filter:** ใช้เฉพาะ transaction ที่ `TRANDATE ≤ scanTimestamp` (เวลาสแกน)  
ถ้าไม่มี TRANDATE → ไม่นับรายการนั้น (conservative — ป้องกัน audit ผิดพลาด)

---

## 6. วงจรสถานะ (Status Lifecycle)

```
pending
  └─→ scanning  (มีการสแกน)
        └─→ pass           (effectiveCnt == systemQty)
        └─→ audit          (effectiveCnt != systemQty)
                └─→ pass              (เภสัชตรวจซ้ำ → ตรงกับ systemQty)
                └─→ stock_adjustment  (เภสัชตรวจซ้ำ → ไม่ตรง)

unknown  (barcode ไม่พบในระบบ — track แยกต่างหาก)
```

`audit_check` มีในโค้ดเพื่อ compatibility แต่ไม่ถูกสร้างใหม่แล้ว

---

## 7. Pharmacist Re-audit Flow

เฉพาะ role `pharmacist` เท่านั้น:

1. เปิด popup รายการสต็อก → กรอง **Audit**
2. กดปุ่ม **ตรวจซ้ำ** บนแถวที่ status = `audit`
3. Modal เปิด → เภสัชสแกน barcode ซ้ำ → `_reauditQty` สะสม
4. กด **ยืนยันผลตรวจซ้ำ**:
   - `_reauditQty == systemQty` → status: `pass`
   - `_reauditQty != systemQty` → status: `stock_adjustment`
5. บันทึก `sd.auditor = currentUser`

---

## 8. Popup รายการสต็อก

เปิดด้วยปุ่ม **Check Product List** แสดงสูงสุด **500** แถว

| Filter | เนื้อหา |
|---|---|
| ทั้งหมด | ทุก SKU |
| Pass | status = pass / audit_check |
| Audit | status = audit / stock_adjustment |
| Unknown | barcode ไม่พบในระบบ |
| DEL | SKU ใน R01 แต่ไม่อยู่ใน Product Master |
| รอนับ | status = pending |

**การค้นหา:**
- ตัวอักษร → ค้นชื่อสินค้า / SKU / barcode / location
- ตัวเลข → ค้นด้วย prefix ย่อลงทีละตัวถ้าไม่พบ

**แก้ไข qty inline:** ทำได้เมื่อ `systemQty > 100` และ status เป็น `pending` หรือ `scanning`

---

## 9. Export Excel

| ปุ่ม | ผลลัพธ์ |
|---|---|
| ⬇️ Export (header) | export เฉพาะ status `audit` + `stock_adjustment` → `audit_${date}.xlsx` |
| ⬇️ Export Excel (popup) | เหมือนกัน |
| ⬇️ Export Excel (ประวัติ) | export ข้อมูลประวัติวันที่เลือก → `history_${branch}_${date}.xlsx` |

---

## 10. ประวัติการนับ (History)

ปุ่ม **📅 ประวัติ** → เลือกวันที่ → ดูผลการนับย้อนหลัง

- สร้างเมื่อกด **🔄 เริ่มนับใหม่** (ต้องใส่ PIN `22190`)
- บันทึกใน localStorage: `stockCountHistory_${branch}` (สูงสุด 60 entries)
- sync ขึ้น Firestore: `stock_history/${branch}_${date}`

---

## 11. การ Sync ข้อมูล

```
สแกน/แก้ไข
    ↓
saveSession() — debounce 400ms → localStorage
    ↓
syncToFirestore() — delay 3 วินาที → Firestore stock_sessions/${branch}
```

**Multi-device:** เครื่องอื่นกดปุ่ม **Cloud** เพื่อดึงข้อมูลล่าสุด  
**Admin Mode:** ปิดการ sync Firestore (local only)

### Persistence ทั้งหมด

| ที่เก็บ | ข้อมูล |
|---|---|
| localStorage `stockCountSession_${branch}` | scanData, r16SalesMap, r16InboundMap, scanListMap |
| Firestore `stock_sessions/${branch}` | scanData + r16 maps |
| Firestore `stock_sessions/${branch}_r01/r05` | master data R01/R05 |
| Firestore `stock_sessions/global_pm` | Product Master (ทุกสาขาร่วมกัน) |
| Firestore `stock_history/${branch}_${date}` | ประวัติการนับ |
| JSON download | backup ไฟล์ |

---

## 12. Backup / Restore

- **💾 Backup** → download JSON ครอบคลุม r01Data, r05Data, r16Maps, scanData, unknownScans
- **📂 Restore** → upload JSON → ระบบ overwrite ข้อมูลปัจจุบันและ sync ขึ้น Firestore

---

## 13. Admin Mode

ใส่ PIN `22190` ที่ปุ่ม **🔒 Administrator**:

- แสดง upload panel สำหรับ Product Master และ R05
- ปิด time-gate (อัพโหลด R01 ได้ทุกเวลา)
- **ปิดการ sync Firestore** ทั้งหมด (local only)
- ออกจาก Admin Mode โดยกดปุ่มเดิมอีกครั้ง

---

## 14. Auto-Update (Service Worker)

เมื่อมีเวอร์ชันใหม่:

1. SW ใหม่ install และ `skipWaiting()` ทันที
2. `controllerchange` → บันทึก `currentUser` + `currentRole` ใน sessionStorage
3. แสดง banner "🔄 กำลังอัพเดทเวอร์ชันใหม่..." 1.5 วินาที → `reload()`
4. หลัง reload: ถ้ามี flag `_autoUpdate` → ข้าม branch/PIN/employee selector → เข้า `initAfterLogin()` ตรงเลย

---

## 15. Responsive / Device

| ขนาดหน้าจอ | พฤติกรรม |
|---|---|
| ≥ 820px | 2 column (upload panel ซ้าย + scan panel ขวา) |
| ≤ 820px | ปรับ padding/font ลด |
| ≤ 600px (PDA/phone) | 1 column, ซ่อน left panel, ซ่อนปุ่ม Confirm, lock scroll, scan list เต็มหน้าจอ |

- ล็อค orientation แนวตั้งด้วย `screen.orientation.lock('portrait')`
- scan input refocus อัตโนมัติเมื่อกลับมา foreground หรือแตะพื้นที่ว่าง
