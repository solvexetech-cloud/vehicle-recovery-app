# 🚀 VEHICLE RECOVERY APP - MASTER PLAN & ROADMAP

## 📌 Project Overview
- **App Name:** Vehicle Recovery App (On-demand Towing & Recovery)
- **Tech Stack:** Node.js, Express.js, SQLite (node:sqlite), Vanilla JS/CSS (PWA Ready), Leaflet Maps.
- **Target Platforms:** Web App (PWA), Future: Google Play Store & Apple App Store.

---

## ✅ Phase 1-12: COMPLETED (Base Architecture & UI)
- [x] Backend APIs (Auth, Booking, Driver, Agency, Admin, Super Admin).
- [x] 366 Automated Tests passing successfully.
- [x] Premium UI/UX Design System (Uber-style).
- [x] Multi-language Support (English / Arabic RTL).
- [x] Dark & Light Themes with LocalStorage memory.
- [x] Responsive Layout (Mobile, Tablet, Desktop Sidebar).
- [x] Role-based Color Themes:
  - Customer: Lime Green & Black
  - Driver: Cyan Blue
  - Agency: Purple
  - Admin: Lime Green

---

## 🚀 Phase 13: CURRENT FOCUS (Web App & Core Enhancements)
- [ ] **PWA (Progressive Web App) Setup:**
  - [ ] Create `manifest.json` and `sw.js` (Service Worker).
  - [ ] Add "Add to Home Screen" install prompt.
  - [ ] Generate App Icons (192x192, 512x512).
- [ ] **Maps Integration (Completed Base):**
  - [x] Leaflet + OpenStreetMap + OSRM (Free Routing).
  - [ ] Live Tracking (Driver location update on map).
- [ ] **Payment Gateway (Test Mode):**
  - [ ] Integrate Sadad/MyFatoorah Sandbox UI.
  - [ ] Add "Cash on Delivery" option.
- [ ] **Frontend Logic Fixes:**
  - [x] Login API payload fix (`identifier` instead of `email`).
  - [x] Customer page redirection fix.

---

## 💡 Phase 14: FUTURE ROADMAP (Advanced Features)
- [ ] **Driver Wallet System (Optional Feature):**
  - [ ] Super Admin Toggle Switch to Enable/Disable Wallet globally.
  - [ ] **Backend:** `wallet_enabled` setting, `driver_wallets` table, `wallet_transactions` table.
  - [ ] **Logic:** Deduct commission (e.g., 10%) from driver wallet upon trip completion.
  - [ ] **Logic:** Prevent "Go Online" if wallet balance drops below a negative limit (e.g., -50 QAR).
  - [ ] **Driver UI:** Show Wallet tab ONLY if enabled by Admin.
- [ ] **Push Notifications:**
  - [ ] Notify drivers of new booking requests.
  - [ ] Notify customer when driver is nearby.
- [ ] **Agency Dashboard Enhancements:**
  - [ ] Revenue charts and analytics for fleet owners.
- [ ] **Admin UI Polish:**
  - [ ] Support ticket resolution interface.
  - [ ] Global analytics graphs.

---

## 🔒 Key Technical Decisions & Rules
1. **No Google Maps:** Use 100% Free OpenStreetMap (OSM) stack to avoid billing.
2. **PWA First:** Focus on Web App now. Use `PWABuilder` later for Play Store/App Store deployment.
3. **Strict UI Consistency:** All pages must use the same `.card`, `.btn`, `.list-item`, and border rules.
4. **Security:** Always use `identifier` for login API payloads.
