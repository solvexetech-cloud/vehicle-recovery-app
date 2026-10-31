(function() {
    // 1. Tab Switching
    window.switchTab = function(tabName) {
        ['home', 'services', 'activity', 'account'].forEach(t => {
            const tab = document.getElementById('tab-' + t);
            if(tab) tab.style.display = 'none';
            const nav = document.getElementById('nav-' + t);
            if(nav) nav.classList.remove('active');
        });

        const activeTab = document.getElementById('tab-' + tabName);
        if(activeTab) activeTab.style.display = 'block';
        
        const activeNav = document.getElementById('nav-' + tabName);
        if(activeNav) activeNav.classList.add('active');
    };

    // 2. Modals
    window.openModal = function(id) { document.getElementById(id).style.display = 'flex'; };
    window.closeModal = function(id) { document.getElementById(id).style.display = 'none'; };

    // 3. Vehicles Logic
    window.loadVehicles = async function() {
        try {
            const res = await fetch('/api/customer/manage/vehicles');
            const data = await res.json();
            const list = document.getElementById('vehicles-list');
            if(!list) return;
            if (data.length === 0) { list.innerHTML = '"<div class="empty-compact"><div class="empty-compact-icon">🚗</div><div class="empty-compact-body"><div class="empty-compact-title">No vehicles yet</div><div class="empty-compact-sub">Add your first vehicle</div></div></div>"'; return; }
            list.innerHTML = data.map(v => `
                <div style="display:flex; justify-content:space-between; align-items:center; padding:15px; background:#f9fafb; border-radius:10px; margin-bottom:10px;">
                    <div><strong style="display:block;">${v.make} ${v.model}</strong><span style="font-size:13px; color:#6b7280;">${v.category} • ${v.registration || 'No Plate'}</span></div>
                    <button onclick="deleteVehicle(${v.id})" style="background:#fee2e2; color:#ef4444; border:none; padding:8px 12px; border-radius:8px; font-weight:bold; cursor:pointer;">Delete</button>
                </div>
            `).join('');
        } catch(e) {}
    };

    window.saveVehicle = async function() {
        const make = document.getElementById('v-make').value;
        const model = document.getElementById('v-model').value;
        const reg = document.getElementById('v-reg').value;
        if(!make || !model) return alert('Make and Model required');
        await fetch('/api/customer/manage/vehicles', {
            method: 'POST', headers: {'Content-Type': 'application/json'},
            body: JSON.stringify({ make, model, registration: reg, category: 'SUV' })
        });
        closeModal('vehicle-modal'); loadVehicles();
    };

    window.deleteVehicle = async function(id) {
        if(confirm('Delete this vehicle?')) { await fetch('/api/customer/manage/vehicles/'+id, {method:'DELETE'}); loadVehicles(); }
    };

    // 4. Destinations Logic
    window.loadDestinations = async function() {
        try {
            const res = await fetch('/api/customer/manage/destinations');
            const data = await res.json();
            const list = document.getElementById('destinations-list');
            if(!list) return;
            if (data.length === 0) { list.innerHTML = '"<div class="empty-compact"><div class="empty-compact-icon">📍</div><div class="empty-compact-body"><div class="empty-compact-title">No saved places</div><div class="empty-compact-sub">Save frequent destinations</div></div></div>"'; return; }
            list.innerHTML = data.map(d => `
                <div style="display:flex; justify-content:space-between; align-items:center; padding:15px; background:#f9fafb; border-radius:10px; margin-bottom:10px;">
                    <div><strong style="display:block;">${d.name}</strong><span style="font-size:13px; color:#6b7280;">${d.address}</span></div>
                    <button onclick="deleteDestination(${d.id})" style="background:#fee2e2; color:#ef4444; border:none; padding:8px 12px; border-radius:8px; font-weight:bold; cursor:pointer;">Delete</button>
                </div>
            `).join('');
        } catch(e) {}
    };

    window.saveDestination = async function() {
        const name = document.getElementById('d-name').value;
        const address = document.getElementById('d-address').value;
        if(!name || !address) return alert('Both fields required');
        await fetch('/api/customer/manage/destinations', {
            method: 'POST', headers: {'Content-Type': 'application/json'},
            body: JSON.stringify({ name, address })
        });
        closeModal('dest-modal'); loadDestinations();
    };

    window.deleteDestination = async function(id) {
        if(confirm('Delete this destination?')) { await fetch('/api/customer/manage/destinations/'+id, {method:'DELETE'}); loadDestinations(); }
    };

    // 5. Live Tracking Logic (Scoped inside this function so no duplicates)
    let localSocket = typeof io !== 'undefined' ? io() : null;
    let trackMap = null, driverMarker = null, pathLine = null, routeCoords = [];

    window.startLiveTracking = function(bookingId) {
        const container = document.getElementById('live-tracking-container');
        if (container) container.style.display = 'block';
        
        if (!window._trackMap) {
            window._trackMap = L.map('live-tracking-map').setView([25.2854, 51.5310], 14);
            L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { attribution: '© OpenStreetMap' }).addTo(window._trackMap);
            
            const carSvg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="#84cc16" stroke="#0a0a0a" stroke-width="2"><path d="M10 17h4V5H2v12h3m10 0h4m-4 0a3 3 0 1 1-6 0m6 0a3 3 0 1 0 6 0M9 17a3 3 0 1 1-6 0m6 0a3 3 0 1 0 6 0"/><path d="M22 17h-4V9h3l3 4v4z"/></svg>';
            const carIcon = L.icon({ iconUrl: 'data:image/svg+xml;utf8,' + encodeURIComponent(carSvg), iconSize: [40, 40], iconAnchor: [20, 20] });
            
            window._pickupCoords = [25.2854, 51.5310];
            window._pickupMarker = L.marker(window._pickupCoords, { icon: L.divIcon({ className: 'pickup-marker', html: '<div style="background:#84cc16;width:16px;height:16px;border-radius:50%;border:3px solid #fff;box-shadow:0 2px 8px rgba(0,0,0,0.3);"></div>', iconSize: [22, 22] }) }).addTo(window._trackMap);
            window._pickupMarker.bindPopup('📍 Pickup');
            
            window._driverMarker = L.marker([25.2854, 51.5310], {icon: carIcon}).addTo(window._trackMap);
            window._driverMarker.bindPopup('🚗 Driver');
            
            window._remainingLine = L.polyline([], {color: '#84cc16', weight: 6, opacity: 0.9}).addTo(window._trackMap);
            window._completedLine = L.polyline([], {color: '#f59e0b', weight: 6, opacity: 0.9}).addTo(window._trackMap);
            window._driverHistory = [];
        }
        
        setTimeout(function() { window._trackMap.invalidateSize(); }, 200);
        
        fetch('/api/customer/bookings/' + bookingId, { credentials: 'include' })
            .then(r => r.json())
            .then(booking => {
                if (booking.pickup_lat && booking.pickup_lng) {
                    window._pickupCoords = [booking.pickup_lat, booking.pickup_lng];
                    if (window._pickupMarker) window._pickupMarker.setLatLng(window._pickupCoords);
                }
            }).catch(e => console.warn('Booking:', e));
        
        if (typeof io !== 'undefined') {
            try { io().emit('join_trip', { bookingId: bookingId, role: 'customer' }); } catch(e) {}
        }
        
        if (window._trackingInterval) clearInterval(window._trackingInterval);
        window._trackingInterval = setInterval(async function() {
            try {
                const res = await fetch('/api/customer/bookings/' + bookingId + '/tracking', { credentials: 'include' });
                if (!res.ok) return;
                const data = await res.json();
                // Backend structure: { driver: {...}, live: { driver_gps: {lat, lng} } }
                const gps = (data.live && data.live.driver_gps) 
                    || (data.driver && data.driver.last_gps_lat ? { lat: data.driver.last_gps_lat, lng: data.driver.last_gps_lng } : null);
                
                if (gps && gps.lat && gps.lng) {
                    window._updateDriverPos(gps.lat, gps.lng);
                    
                    // Also show distance from live data
                    if (data.live && data.live.distance_to_pickup_km !== undefined) {
                        const info = document.getElementById('tracking-info');
                        if (info) {
                            const distKm = data.live.distance_to_pickup_km.toFixed(2);
                            info.innerHTML = '<div style="font-size:1.1em;font-weight:700;color:#84cc16;">' + distKm + ' km away</div>'
                                + '<div style="font-size:0.85em;color:#6b7280;">To pickup</div>';
                        }
                    }
                }
            } catch(e) {}
        }, 2000);
        
        setTimeout(async function() {
            try {
                const res = await fetch('/api/customer/bookings/' + bookingId + '/tracking', { credentials: 'include' });
                if (!res.ok) return;
                const data = await res.json();
                const gps2 = (data.live && data.live.driver_gps) || (data.driver && data.driver.last_gps_lat ? { lat: data.driver.last_gps_lat, lng: data.driver.last_gps_lng } : null); if (gps2 && gps2.lat) window._updateDriverPos(gps2.lat, gps2.lng);
            } catch(e) {}
        }, 500);
    };

    window._updateDriverPos = function(lat, lng) {
        if (!window._trackMap || !window._driverMarker) return;
        const pos = [lat, lng];
        
        if (window._driverHistory.length > 0) {
            const last = window._driverHistory[window._driverHistory.length - 1];
            if (last[0] !== lat || last[1] !== lng) {
                window._driverHistory.push(pos);
                // Fetch OSRM route for completed path (yellow trail)
                const from = [last[0], last[1]];
                const to = pos;
                fetchRouteLine(from, to, window._completedLine);
            }
        } else {
            window._driverHistory.push(pos);
        }
        
        window._driverMarker.setLatLng(pos);
        window._fetchRoute(pos, window._pickupCoords);
    };

    // Draw route line using OSRM (replaces straight line)
    function fetchRouteLine(from, to, polyline) {
        const url = 'https://router.project-osrm.org/route/v1/driving/' +
            from[1] + ',' + from[0] + ';' + to[1] + ',' + to[0] +
            '?overview=full&geometries=geojson';
        
        fetch(url)
            .then(r => r.json())
            .then(data => {
                if (data.routes && data.routes[0]) {
                    const coords = data.routes[0].geometry.coordinates.map(c => [c[1], c[0]]);
                    polyline.setLatLngs(coords);
                }
            })
            .catch(e => {
                // Fallback: straight line
                polyline.setLatLngs([from, to]);
            });
    }

    window._fetchRoute = function(from, to) {
        const url = 'https://router.project-osrm.org/route/v1/driving/' + from[1] + ',' + from[0] + ';' + to[1] + ',' + to[0] + '?overview=full&geometries=geojson';
        fetch(url).then(r => r.json()).then(data => {
            if (data.routes && data.routes[0]) {
                const coords = data.routes[0].geometry.coordinates.map(c => [c[1], c[0]]);
                window._remainingLine.setLatLngs(coords);
                const distKm = (data.routes[0].distance / 1000).toFixed(1);
                const etaMin = Math.ceil(data.routes[0].duration / 60);
                const info = document.getElementById('tracking-info');
                if (info) info.innerHTML = '<div style="font-size:1.1em;font-weight:700;color:#84cc16;">' + distKm + ' km</div><div style="font-size:0.85em;color:#6b7280;">ETA: ' + etaMin + ' min</div>';
            }
        }).catch(e => console.warn('OSRM:', e));
    };

    if(localSocket) {
        localSocket.on('driver_location_update', (data) => {
            if(!trackMap) return;
            const pos = [data.lat, data.lng];
            routeCoords.push(pos);
            if(!pathLine) pathLine = L.polyline(routeCoords, {color: '#84cc16', weight: 6}).addTo(trackMap);
            else pathLine.setLatLngs(routeCoords);
            if(!driverMarker) {
                const svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="#84cc16" stroke="#0a0a0a" stroke-width="2" style="background:#fff;border-radius:50%;padding:4px;box-shadow:0 4px 10px rgba(0,0,0,0.4);"><path d="M10 17h4V5H2v12h3m10 0h4m-4 0a3 3 0 1 1-6 0m6 0a3 3 0 1 0 6 0M9 17a3 3 0 1 1-6 0m6 0a3 3 0 1 0 6 0"/><path d="M22 17h-4V9h3l3 4v4z"/></svg>';
                const icon = L.icon({ iconUrl: 'data:image/svg+xml;utf8,'+encodeURIComponent(svg), iconSize: [40,40], iconAnchor: [20,20] });
                driverMarker = L.marker(pos, {icon}).addTo(trackMap);
            } else {
                driverMarker.setLatLng(pos);
            }
            trackMap.panTo(pos);
        });
    }

    // 6. Initialization
    document.addEventListener('DOMContentLoaded', () => {
        const mapEl = document.getElementById('map-container');
        if (mapEl && typeof L !== 'undefined') {
            const map = L.map('map-container').setView([25.2854, 51.5310], 11);
            L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { attribution: '© OpenStreetMap' }).addTo(map);
            L.marker([25.2854, 51.5310]).addTo(map).bindPopup('Default Pickup Location');
        }
        loadVehicles();
        loadDestinations();
    });

    // ═══════════════════════════════════════════════════════
    // PHASE 13: AUTH + BOOKING + TRACKING FUNCTIONS
    // Added 2026-10-30 - extends original app.js (safe append)
    // ═══════════════════════════════════════════════════════

    // ─── Auth helpers ───
    function getToken() {
        try { return localStorage.getItem('vra_token') || localStorage.getItem('token') || (localStorage.getItem('vra_session_active') ? 'cookie-session' : ''); }
        catch(e) { return ''; }
    }
    function setToken(t) {
        try { localStorage.setItem('vra_token', t); localStorage.setItem('token', t); } catch(e) {}
    }
    function clearToken() {
        try { localStorage.removeItem('vra_token'); localStorage.removeItem('token');
              localStorage.removeItem('vra_user'); localStorage.removeItem('user'); localStorage.removeItem('vra_session_active'); } catch(e) {}
    }
    function getUser() {
        try { return JSON.parse(localStorage.getItem('vra_user') || localStorage.getItem('user') || 'null'); }
        catch(e) { return null; }
    }
    function setUser(u) {
        try { localStorage.setItem('vra_user', JSON.stringify(u)); localStorage.setItem('user', JSON.stringify(u)); } catch(e) {}
    }

    // ─── API fetch with auth + error handling ───
    async function apiFetch(path, opts) {
        opts = opts || {};
        const headers = Object.assign({}, opts.headers || {});
        const token = getToken() || localStorage.getItem('vra_session_active') || '';
        if (token) headers['Authorization'] = 'Bearer ' + token;
        if (opts.body && typeof opts.body === 'object' && !(opts.body instanceof FormData)) {
            headers['Content-Type'] = 'application/json';
            opts.body = JSON.stringify(opts.body);
        }
        const res = await fetch(path, Object.assign({}, opts, { headers, credentials: 'include' }));
        const text = await res.text();
        let data = null;
        try { data = text ? JSON.parse(text) : null; } catch(e) { data = { raw: text }; }
        if (!res.ok) {
            const msg = (data && (data.error || data.message)) || ('HTTP ' + res.status);
            throw new Error(msg);
        }
        return data;
    }

    // ─── Toast notification ───
    function showToast(msg, type) {
        let el = document.getElementById('vra-toast');
        if (!el) {
            el = document.createElement('div');
            el.id = 'vra-toast';
            el.style.cssText = 'position:fixed;bottom:100px;left:50%;transform:translateX(-50%);padding:12px 24px;border-radius:12px;background:var(--card);color:var(--fg);border:1px solid var(--border);z-index:99999;font-weight:600;box-shadow:0 10px 30px rgba(0,0,0,0.4);max-width:90%;text-align:center;transition:opacity 0.3s;';
            document.body.appendChild(el);
        }
        el.style.background = type === 'error' ? 'var(--danger)' : (type === 'success' ? 'var(--success)' : 'var(--card)');
        el.style.color = type === 'error' || type === 'success' ? '#fff' : 'var(--fg)';
        el.textContent = msg;
        el.style.opacity = '1';
        clearTimeout(el._timer);
        el._timer = setTimeout(function() { el.style.opacity = '0'; }, 3000);
    }

    // ─── Login ───
    window.login = async function() {
        const email = (document.getElementById('login-email') || {}).value;
        const password = (document.getElementById('login-password') || {}).value;
        if (!email || !password) return showToast('Email and password required', 'error');
        try {
            const data = await apiFetch('/api/auth/login', {
                method: 'POST',
                body: { identifier: email.trim(), password: password }
            });
            const token = data.token || data.sessionToken || (data.session && data.session.token);
            if (token) setToken(token);
            if (data.user) { setUser(data.user); try { localStorage.setItem('vra_session_active', '1'); } catch(e) {} }
            showToast('Login successful', 'success');
            updateUIForAuth();
            loadActiveBooking();
            loadBookingHistory();
        } catch(e) {
            showToast('Login failed: ' + e.message, 'error');
        }
    };

    // ─── Logout ───
    window.logout = async function() {
        try { await apiFetch('/api/auth/logout', { method: 'POST' }); } catch(e) {}
        clearToken();
        showToast('Logged out', 'success');
        updateUIForAuth();
    };

    // ─── UI: show/hide login vs app ───
    function updateUIForAuth() {
        const token = getToken() || localStorage.getItem('vra_session_active') || '';
        const loginScreen = document.getElementById('login-screen');
        const appMain = document.getElementById('app-main');
        const bottomNav = document.getElementById('main-bottom-nav');
        if (token) {
            if (loginScreen) loginScreen.style.display = 'none';
            if (appMain) appMain.style.display = 'block';
            if (bottomNav) bottomNav.style.display = 'flex';
            const user = getUser();
            const accInfo = document.getElementById('account-info');
            if (accInfo && user) {
                accInfo.innerHTML = '<div class="list-item">'
                    + '<div><div class="list-item-title">' + (user.name || user.email || 'User') + '</div>'
                    + '<div style="color:var(--muted);font-size:0.85em;">' + (user.email || '') + '</div></div>'
                    + '</div>';
            }
        } else {
            if (loginScreen) loginScreen.style.display = 'block';
            if (appMain) appMain.style.display = 'none';
            if (bottomNav) bottomNav.style.display = 'none';
        }
    }

    // ─── Booking: submit ───
    window.submitBooking = async function() {
        if (!getToken()) return showToast('Please login first', 'error');
        const serviceType = (document.getElementById('service-type') || {}).value || 'towing';
        const pickup = (document.getElementById('pickup-loc') || {}).value;
        const dest = (document.getElementById('dest-loc') || {}).value;
        const reg = (document.getElementById('vehicle-reg') || {}).value;
        const level = (document.getElementById('service-level') || {}).value || 'normal';
        if (!pickup) return showToast('Pickup location required', 'error');
        if (!dest) return showToast('Destination required', 'error');
        try {
            const estimatePayload = {
                service_type: serviceType,
                service_level: level,
                pickup: { lat: 25.2854, lng: 51.5310, address: pickup },
                destination: { lat: 25.2854, lng: 51.5310, address: dest },
                vehicle: { category: 'suv', registration_number: reg || 'QA-00000' }
            };
            const estimate = await apiFetch('/api/customer/bookings/estimate', {
                method: 'POST',
                body: estimatePayload
            });
            const agreedFare = estimate && estimate.fare_breakdown ? estimate.fare_breakdown.total_minor : 0;
            if (!agreedFare) {
                return showToast('Could not get fare estimate', 'error');
            }
            const bookingPayload = {
                service_type: serviceType,
                service_level: level,
                pickup: { lat: 25.2854, lng: 51.5310, address: pickup },
                destination: { lat: 25.2854, lng: 51.5310, address: dest },
                vehicle: { category: 'suv', registration_number: reg || 'QA-00000' },
                agreed_fare_minor: agreedFare
            };
                        const bookingResp = await apiFetch('/api/customer/bookings', { method: 'POST', body: bookingPayload });
            
            // Extract from nested shape: { ok: true, booking: { id, ... } }
            const booking = bookingResp.booking || bookingResp;
            const bookingId = booking.id || bookingResp.id;
            
            console.log('📦 Booking created:', bookingId);
            
            // Trigger dispatch automatically
            if (bookingId) {
                try {
                    console.log('🚀 Dispatching booking', bookingId);
                    const dispatchResult = await apiFetch('/api/customer/bookings/' + bookingId + '/dispatch', { method: 'POST' });
                    console.log('✅ Dispatch result:', dispatchResult.dispatch?.status);
                } catch(dispatchErr) {
                    console.warn('❌ Dispatch failed:', dispatchErr.message);
                }
            }
            
            showToast('Booking created! Searching for driver...', 'success');
            if (booking && booking.id) {
                loadActiveBooking();
                loadBookingHistory();
                if (typeof window.startLiveTracking === 'function' && booking.id) {
                    try { window.startLiveTracking(booking.id); } catch(e) {}
                }
            }
        } catch(e) {
            showToast('Booking failed: ' + e.message, 'error');
        }
    };;

    // ─── Active booking loader ───
    async function loadActiveBooking() {
        if (!getToken()) return;
        try {
            const list = await apiFetch('/api/customer/bookings');
            const arr = Array.isArray(list) ? list : (list.bookings || list.items || []);
            // Sort by ID descending to get newest first
            const sorted = arr.slice().sort(function(a, b) { return (b.id || 0) - (a.id || 0); });
            const active = sorted.find(function(b) {
                return b && b.status && !['trip_completed','cancelled','payment_completed','no_driver_available'].includes(b.status);
            });
            const panel = document.getElementById('active-booking-panel');
            if (active && panel) {
                panel.style.display = 'block';
                const info = document.getElementById('active-booking-info');
                const statusEl = document.getElementById('active-booking-status');
                if (statusEl) statusEl.textContent = String(active.status || '').replace(/_/g,' ').toUpperCase();
                if (statusEl) statusEl.className = 'badge ' + (active.status || '');
                if (info) {
                    const bNum = active.booking_number || active.bookingNumber || active.id;
                    const pAddr = active.pickup_address || active.pickupAddress 
                                  || (active.pickup && active.pickup.address) || '—';
                    const dAddr = active.destination_address || active.destinationAddress 
                                  || (active.destination && active.destination.address) || '—';
                    const fare = active.agreed_fare_minor 
                                 ? 'QAR ' + (active.agreed_fare_minor / 100).toFixed(2) 
                                 : '';
                    info.innerHTML = 'Booking #' + bNum 
                        + (fare ? ' • ' + fare : '')
                        + '<br>📍 ' + pAddr 
                        + '<br>🏁 ' + dAddr;
                }
                window._activeBooking = active;
            } else if (panel) {
                panel.style.display = 'none';
                window._activeBooking = null;
            }
        } catch(e) { /* silent — not logged in or offline */ }
    }
    window.loadActiveBooking = loadActiveBooking;

    // ─── Active booking: cancel ───
    window.cancelActiveBooking = async function() {
        const active = window._activeBooking;
        if (!active || !active.id) return showToast('No active booking', 'error');
        if (!confirm('Cancel this booking?')) return;
        try {
            await apiFetch('/api/customer/bookings/' + active.id + '/cancel', { method: 'POST', body: { reason: 'customer_cancelled' } });
            showToast('Booking cancelled', 'success');
            loadActiveBooking();
            loadBookingHistory();
        } catch(e) {
            showToast('Cancel failed: ' + e.message, 'error');
        }
    };

    // ─── Booking history ───
    async function loadBookingHistory() {
        if (!getToken()) return;
        const container = document.getElementById('booking-history');
        if (!container) return;
        try {
            const list = await apiFetch('/api/customer/bookings');
            const arr = Array.isArray(list) ? list : (list.bookings || list.items || []);
            if (!arr.length) {
                container.innerHTML = '<p style="text-align:center;color:var(--muted);padding:20px;">No bookings yet</p>';
                return;
            }
            container.innerHTML = arr.map(function(b) {
                const status = String(b.status || '');
                return '<div class="list-item">'
                    + '<div class="list-item-header"><div class="list-item-title">#' + (b.bookingNumber || b.id) + '</div>'
                    + '<span class="badge ' + status + '">' + status.replace(/_/g,' ').toUpperCase() + '</span></div>'
                    + '<div style="color:var(--muted);font-size:0.85em;">'
                    + (b.pickupAddress || '—') + ' → ' + (b.destinationAddress || '—')
                    + '</div>'
                    + (b.finalFare || b.estimatedFare ? '<div style="margin-top:8px;font-weight:600;">QAR ' + (b.finalFare || b.estimatedFare) + '</div>' : '')
                    + '</div>';
            }).join('');
        } catch(e) {
            container.innerHTML = '<p style="color:var(--danger);padding:20px;">Failed to load: ' + e.message + '</p>';
        }
    }
    window.loadBookingHistory = loadBookingHistory;

    // ─── Live tracking open/close (overlay) ───
    window.openLiveTracking = function() {
        const active = window._activeBooking;
        const container = document.getElementById('live-tracking-container');
        if (!container) return;
        container.style.display = 'block';
        if (active && active.id && typeof window.startLiveTracking === 'function') {
            try { window.startLiveTracking(active.id); } catch(e) {}
        }
    };
    window.closeLiveTracking = function() {
        const container = document.getElementById('live-tracking-container');
        if (container) container.style.display = 'none';
    };

    // ─── Select service from Services tab ───
    window.selectService = function(code) {
        const sel = document.getElementById('service-type');
        if (sel && code) sel.value = code;
        switchTab('home');
        showToast('Service selected: ' + code.replace(/_/g,' '), 'success');
    };

    // ─── Rating ───
    let ratingValue = 0;
    window.submitRating = async function() {
        const modal = document.getElementById('rating-modal');
        const comment = (document.getElementById('rating-comment') || {}).value || '';
        if (!ratingValue) return showToast('Please select stars', 'error');
        const active = window._activeBooking;
        try {
            if (active && active.id) {
                await apiFetch('/api/customer/bookings/' + active.id + '/rate', {
                    method: 'POST',
                    body: { rating: ratingValue, comment: comment }
                });
            }
            showToast('Rating submitted!', 'success');
            if (modal) modal.style.display = 'none';
            ratingValue = 0;
            loadActiveBooking();
        } catch(e) {
            showToast('Rating failed: ' + e.message, 'error');
        }
    };

    // ─── Theme toggle ───
    window.toggleTheme = function() {
        const cur = document.documentElement.getAttribute('data-theme') || 'dark';
        const next = cur === 'dark' ? 'light' : 'dark';
        document.documentElement.setAttribute('data-theme', next);
        try { localStorage.setItem('vra_theme', next); } catch(e) {}
        const btn = document.getElementById('theme-toggle');
        if (btn) btn.textContent = next === 'dark' ? '🌙' : '☀️';
    };

    // ─── Language toggle ───
    window.toggleLanguage = function() {
        const cur = document.documentElement.getAttribute('dir') === 'rtl' ? 'ar' : 'en';
        const next = cur === 'ar' ? 'en' : 'ar';
        document.documentElement.setAttribute('dir', next === 'ar' ? 'rtl' : 'ltr');
        document.documentElement.setAttribute('lang', next);
        try { localStorage.setItem('vra_lang', next); } catch(e) {}
        const btn = document.getElementById('lang-toggle');
        if (btn) btn.textContent = next === 'ar' ? 'English' : 'العربية';
        if (typeof window.applyTranslations === 'function') {
            try { window.applyTranslations(next); } catch(e) {}
        }
    };

    // ─── Rating stars builder ───
    function buildRatingStars() {
        const el = document.getElementById('rating-stars');
        if (!el) return;
        el.innerHTML = '';
        for (let i = 1; i <= 5; i++) {
            const s = document.createElement('span');
            s.textContent = '★';
            s.style.color = '#555';
            s.style.cursor = 'pointer';
            s.onclick = function() {
                ratingValue = i;
                Array.from(el.children).forEach(function(child, idx) {
                    child.style.color = idx < i ? '#FFD60A' : '#555';
                });
            };
            el.appendChild(s);
        }
    }

    // ─── Init after DOM ready ───
    document.addEventListener('DOMContentLoaded', function() {
        // Restore theme/lang
        try {
            const th = localStorage.getItem('vra_theme');
            if (th) document.documentElement.setAttribute('data-theme', th);
            const lang = localStorage.getItem('vra_lang');
            if (lang) {
                document.documentElement.setAttribute('dir', lang === 'ar' ? 'rtl' : 'ltr');
                document.documentElement.setAttribute('lang', lang);
            }
        } catch(e) {}

        buildRatingStars();
        updateUIForAuth();

        // Poll active booking every 10s if logged in
        if (getToken()) {
            loadActiveBooking();
            loadBookingHistory();
            setInterval(function() { loadActiveBooking(); }, 10000);
        }
    });

    // Expose for socket handlers
    window._vraApiFetch = apiFetch;
    window._vraShowToast = showToast;

    // ═══ Empty state action handlers ═══
    document.addEventListener('click', function(e) {
        const btn = e.target.closest('[data-action]');
        if (!btn) return;
        const action = btn.getAttribute('data-action');
        if (action === 'open-vehicle') openModal('vehicle-modal');
        if (action === 'open-dest') openModal('dest-modal');
    });

})();
