# Backend Architecture Documentation
## Stock Count System - Backend Structure & Workflow

---

## 🏗️ ระบบสถาปัตยกรรม

### **ประเภทระบบ**
- **Client-Side Application** ทำงานบน Browser ทั้งหมด
- **ไม่มี Server Backend** แยกอยู่ แต่ใช้ JavaScript จำลองฟังก์ชัน Backend
- **Storage**: LocalStorage + Google Sheets (External Service)

---

## 📊 โครงสร้างข้อมูล (Data Structure)

### **1. Global State Object**
```javascript
const state = {
  mode: 'stock100',              // โหมดการทำงาน (stock100/catA)
  r01Data: [],                  // ข้อมูล SystemQty จาก R01.102
  r05Data: [],                  // ข้อมูล Barcode จาก R05.106
  catASkus: new Set(),          // Set ของ SKU กลุ่ม A
  catSkuMap: new Map(),         // Map SKU → Category
  skuMap: new Map(),            // Map SKU → Product Info
  barcodeMap: new Map(),        // Map Barcode → SKU
  skuDirectMap: new Map(),      // Map SKU → Barcode (หน่วยเล็กสุด)
  scanData: new Map(),          // ข้อมูลการสแกนตาม SKU
  unknownScans: [],             // ข้อมูลที่ไม่พบในระบบ
  currentFilter: 'all',         // Filter ปัจจุบัน
  pendingAuditSku: null          // SKU ที่รอการตรวจสอบ
};
```

### **2. Session Management**
```javascript
const sessions = {
  scanner: null,    // ข้อมูลผู้สแกน (PIN authentication)
  auditor: null     // ข้อมูลผู้ตรวจสอบ (PIN authentication)
};
```

### **3. User Authentication**
```javascript
const USERS = [
  { pin: '111111', name: 'ก้า',       role: 'scanner' },
  { pin: '222222', name: 'บอล',       role: 'scanner' },
  { pin: '333333', name: 'ใหม่',      role: 'scanner' },
  { pin: '444444', name: 'สุดา',      role: 'auditor' },
  { pin: '555555', name: 'ประสิทธิ์', role: 'auditor' }
];
```

---

## 🔧 ฟังก์ชัน Backend หลัก

### **1. Data Processing Functions**

#### **File Parser & Loader**
- `parseFile(file, callback)` - อ่านไฟล์ CSV/XLSX
- `loadR01(event)` - โหลดข้อมูล SystemQty (คอลัมน์ E,F,G)
- `loadR05(event)` - โหลดข้อมูล Barcode (คอลัมน์ A,E,H)
- `loadCatA(event)` - โหลดข้อมูล Category A (คอลัมน์ A,D)

#### **Data Mapping**
- `rebuildMaps()` - สร้างความสัมพันธ์ SKU-Barcode
- `buildSkuDirectMap()` - สร้าง Map สำหรับ SKU Direct Scan

### **2. Business Logic Engine**

#### **Scan Processing Pipeline**
```javascript
function processScan() {
  // 1. Parse input line
  const parsed = parseScanLine(input);
  
  // 2. Queue processing
  scanQueue.push(parsed);
  
  // 3. Process queue
  drainQueue();
}

function handleBarcode(parsed) {
  // 1. Resolve SKU from barcode
  let sku = state.barcodeMap.get(barcode);
  
  // 2. Handle SKU direct scan
  if (!sku && state.skuDirectMap.has(barcode)) {
    sku = barcode;
    resolvedBarcode = state.skuDirectMap.get(sku).barcode;
  }
  
  // 3. Category validation (Cat A mode)
  if (state.mode === 'catA' && !state.catASkus.has(sku)) {
    // Mark as CAT_OTHER
  }
  
  // 4. Update scan data
  const sd = state.scanData.get(sku);
  sd.countedQty += qty * multiplier;
  sd.status = 'scanning';
  
  // 5. Evaluate status
  evaluatePendingScans();
}
```

#### **Status Evaluation Logic**
```javascript
function evaluatePendingScans() {
  for (const [sku, sd] of state.scanData.entries()) {
    const systemQty = state.skuMap.get(sku).systemQty;
    const countedQty = sd.countedQty;
    
    if (countedQty === systemQty) {
      // ✅ PASS
      sd.status = 'pass';
      sd.auditStatus = 'approved';
    } else if (countedQty > systemQty) {
      // 📈 OVERSTOCK → RETRY LOGIC
      sd.retries++;
      if (sd.retries >= 3) {
        sd.status = 'audit';  // Send to audit after 3 retries
      } else {
        sd.status = sd.retries === 1 ? 'retry1' : 'retry2';
      }
    } else {
      // ❌ SHORTAGE → RETRY LOGIC
      if (sd.retries >= 2) {
        sd.status = 'fail';
        sd.auditStatus = 'pending';
      } else {
        sd.status = sd.retries === 0 ? 'retry1' : 'retry2';
      }
    }
  }
}
```

### **3. Authentication System**

#### **PIN Validation Flow**
```javascript
function validatePinEntry() {
  const user = USERS.find(u => 
    u.role === pinTarget && u.pin === pinBuffer
  );
  
  if (user) {
    // 1. Store session
    sessions[pinTarget] = user.name;
    
    // 2. Update UI
    updateFieldUI(pinTarget, user.name);
    
    // 3. Save session
    saveSession();
  }
}
```

### **4. Data Persistence**

#### **Session Management**
```javascript
function saveSession() {
  const sessionData = {
    mode: state.mode,
    r01Data: state.r01Data,
    r05Data: state.r05Data,
    catASkus: [...state.catASkus],
    scanData: Object.fromEntries(state.scanData),
    unknownScans: state.unknownScans
  };
  
  localStorage.setItem('stockCountSession', JSON.stringify(sessionData));
  
  // Auto-sync to Google Sheets
  if (googleAccessToken) {
    clearTimeout(googleSyncTimer);
    googleSyncTimer = setTimeout(exportToGoogleSheets, 3000);
  }
}
```

---

## 🔄 การทำงานของระบบ (Workflow)

### **1. Initialization Phase**
```
1. DOMContentLoaded → loadSession()
2. Rebuild data maps from localStorage
3. Initialize Google Sheets client
4. Setup event listeners
5. Restore UI state
```

### **2. Data Import Phase**
```
1. User selects CSV/XLSX files
2. parseFile() → PapaParse / SheetJS
3. Extract relevant columns:
   - R01.102: E=SKU, F=Name, G=Qty
   - R05.106: A=Barcode, E=SKU, H=Multiplier
   - Cat A: A=SKU, D=Category
4. rebuildMaps() → Create lookup tables
5. saveSession() → Persist data
```

### **3. Authentication Phase**
```
1. User clicks "Scanned By" or "Auditor"
2. openPinPopup() → Show PIN pad
3. User enters PIN (6 digits)
4. validatePinEntry() → Check against USERS array
5. sessions[target] = user.name
6. Update UI with locked state
```

### **4. Scan Processing Phase**
```
1. User scans barcode/enters data
2. parseScanLine() → Extract location, barcode, qty
3. Add to scanQueue
4. drainQueue() → Process each item
5. handleBarcode() → Business logic
6. evaluatePendingScans() → Status determination
7. renderScanList() → Update UI
8. saveSession() → Persist changes
```

### **5. Status Evaluation Logic**
```
SCANNING STATUS FLOW:

┌─────────────┐
│   PENDING   │
└──────┬──────┘
       ↓ (first scan)
┌─────────────┐
│  SCANNING   │
└──────┬──────┘
       ↓ (confirm)
┌─────────────────┐
│  EVALUATE QTY   │
└───────┬─────────┘
        │
┌───────┴───────┐
│  cnt == sys   │ ──→ ✅ PASS
└───────┬───────┘
        │
┌───────┴───────┐
│  cnt > sys    │ ──→ 🔄 RETRY1 → 🔄 RETRY2 → ⚠️ AUDIT
└───────┬───────┘
        │
┌───────┴───────┐
│  cnt < sys    │ ──→ 🔄 RETRY1 → 🔄 RETRY2 → ❌ FAIL
└───────────────┘
```

### **6. Data Export Phase**
```
1. exportExcel() → Generate XLSX file
2. exportToGoogleSheets() → Sync to cloud
   - Create new spreadsheet if not exists
   - Clear existing data
   - Write new data
   - Handle authentication errors
3. Auto-sync every 3 seconds after changes
```

---

## 🗄️ การจัดการข้อมูล (Data Management)

### **Primary Data Sources**
1. **R01.102** - System Quantity Data
2. **R05.106** - Barcode Mapping Data  
3. **Cat A List** - Category Classification (Optional)

### **Data Transformation**
```javascript
// R01 Processing
state.r01Data.push({
  colE: sku,                    // SKU
  productName: name,           // Product Name
  systemQty: quantity           // System Quantity
});

// R05 Processing  
state.r05Data.push({
  barcode: barcode,             // Barcode
  colE: sku,                   // SKU
  unitName: unit,               // Unit Name
  unitMultiplier: multiplier   // Conversion Factor
});
```

### **Lookup Tables**
```javascript
// SKU → Product Info
state.skuMap.set(sku, {
  sku: sku,
  productName: name,
  systemQty: qty,
  barcodes: [barcode1, barcode2, ...]
});

// Barcode → SKU
state.barcodeMap.set(barcode, sku);
```

---

## 🔐 ความปลอดภัยและการควบคุม

### **Access Control**
- PIN-based authentication (6 digits)
- Role-based access (scanner vs auditor)
- Session timeout handling

### **Data Validation**
- Input sanitization in parseScanLine()
- Numeric validation for quantities
- File format validation (CSV/XLSX only)

### **Error Handling**
- Retry logic for failed scans
- Graceful degradation for missing data
- User feedback via toast notifications

---

## 🌐 External Services Integration

### **Google Sheets API**
```javascript
// Configuration
const GOOGLE_CLIENT_ID = '152908550444-htmbor1l5726r6evmk8mflg74ek8q6cq.apps.googleusercontent.com';
const SCOPES = 'https://www.googleapis.com/auth/spreadsheets';

// Authentication Flow
1. initGoogleClient() → Initialize GAPI
2. handleGoogleSheetsClick() → Request OAuth token
3. exportToGoogleSheets() → Create/Update spreadsheet
4. writeToSheet() → Write data to cells
```

### **Data Sync Strategy**
- **Auto-sync**: 3 seconds after any change
- **Manual sync**: User-triggered via button
- **Conflict resolution**: Overwrite existing data
- **Error recovery**: Re-authentication on token expiry

---

## 📈 Performance Optimization

### **Caching Strategy**
- `popupBaseRowsCache` - Cache table rows for faster rendering
- Debounced functions - Prevent excessive re-renders
- Queue processing - Batch scan operations

### **Memory Management**
- Map/Set data structures for O(1) lookups
- Lazy loading of large datasets
- Garbage collection of unused references

### **Rendering Optimization**
- Virtual scrolling for large tables (max 500 rows)
- Debounced search/filter operations
- Selective DOM updates

---

## 🔄 State Management Flow

```
USER ACTION → BUSINESS LOGIC → STATE UPDATE → UI RENDER → PERSISTENCE
     ↓              ↓              ↓           ↓           ↓
Scan Input → handleBarcode → scanData.set → renderScanList → saveSession
File Upload → loadR01/R05 → rebuildMaps → updateStats → localStorage
PIN Entry → validatePin → sessions.set → updateFieldUI → saveSession
Export Click → exportExcel → N/A → download file → N/A
```

---

## 🚨 Limitations & Considerations

### **Technical Limitations**
- **Browser Storage**: Limited to ~5MB localStorage
- **Single-threaded**: All processing on main thread
- **No Real Backend**: No server-side validation
- **Data Consistency**: Relies on client-side logic

### **Scalability Concerns**
- Large datasets may impact performance
- Concurrent users not supported
- No centralized data management
- Limited offline capabilities

### **Security Considerations**
- PIN validation only (no encryption)
- Data stored in plain text
- Google Sheets access via OAuth
- No audit trail for changes

---

## 📝 สรุป

ระบบนี้เป็น **Frontend-Only Application** ที่ใช้ JavaScript จำลองฟังก์ชัน Backend ทั้งหมด โดย:

1. **Data Layer**: LocalStorage + Google Sheets
2. **Business Logic**: JavaScript functions บน Browser
3. **Authentication**: PIN-based validation
4. **Processing**: Real-time scan processing
5. **Persistence**: Auto-save to localStorage + cloud sync

ระบบออกแบบมาสำหรับการใช้งานแบบ Standalone โดยเน้นความเร็วในการประมวลผลและความสามารถในการทำงานแบบ Offline พร้อมกับการสำรองข้อมูลไปยัง Google Sheets เป็นระยะๆ
