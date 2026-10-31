(function() {
    // ═══════════════════════════════════════════════════════════
    // DRIVER APP — Phase 14
    // ═══════════════════════════════════════════════════════════

    // ─── Auth helpers ───
    function getToken() {
        try {
            const t = localStorage.getItem('vra_token') || localStorage.getItem('token') || '';
            if (t) return t;
            if (localStorage.getItem('vra_session_active')) return 'cookie-session';
            return '';
        } catch(e) { return ''; }
    }
    function setToken(t) {
        try { localStorage.setItem('vra_token', t); localStorage.setItem('token', t); } catch(e) {}
    }
    function clearToken() {
        try { localStorage.removeItem('vra_token'); localStorage.removeItem('token');
              localStorage.removeItem('vra_user'); localStorage.removeItem('user');
              localStorage.removeItem('vra_session_active'); } catch(e) {}
    }
    function getUser() {
        try { return JSON.parse(localStorage.getItem('vra_user') || localStorage.getItem('user') || 'null'); }
        catch(e) { return null; }
    }
    function setUser(u) {
        try { localStorage.setItem('vra_user', JSON.stringify(u)); localStorage.setItem('user', JSON.stringify(u)); } catch(e) {}
    }

    async function apiFetch(path, opts) {
        opts = opts || {};
        const headers = Object.assign({}, opts.headers || {});
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

    function showToast(msg, type) {
        let el = document.getElementById('vra-toast');
        if (!el) {
            el = document.createElement('div');
            el.id = 'vra-toast';
            el.style.cssText = 'position:fixed;bottom:110px;left:50%;transform:translateX(-50%);padding:14px 24px;border-radius:14px;background:var(--card-elevated);color:var(--fg);border:1px solid var(--primary);z-index:99999;font-weight:700;box-shadow:0 12px 32px rgba(0,0,0,0.4);max-width:85%;text-align:center;transition:opacity 0.3s;';
            document.body.appendChild(el);
        }
        el.style.background = type === 'error' ? 'var(--danger)' : (type === 'success' ? 'var(--success)' : 'var(--card-elevated)');
        el.style.color = type === 'error' || type === 'success' ? '#fff' : 'var(--fg)';
        el.textContent = msg;
        el.style.opacity = '1';
        clearTimeout(el._timer);
        el._timer = setTimeout(function() { el.style.opacity = '0'; }, 3000);
    }

    window.switchTab = function(tabName) {
        ['home', 'trip', 'earnings', 'account'].forEach(function(t) {
            const tab = document.getElementById('tab-' + t);
            if (tab) tab.style.display = (t === tabName) ? 'block' : 'none';
            const nav = document.getElementById('nav-' + t);
            if (nav) nav.classList.remove('active');
        });
        const activeNav = document.getElementById('nav-' + tabName);
        if (activeNav) activeNav.classList.add('active');
        if (typeof lucide !== 'undefined') setTimeout(() => lucide.createIcons(), 50);
    };

    window.openModal = function(id) { const el = document.getElementById(id); if (el) el.style.display = 'flex'; };
    window.closeModal = function(id) { const el = document.getElementById(id); if (el) el.style.display = 'none'; };

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
            if (data.user) {
                setUser(data.user);
                try { localStorage.setItem('vra_session_active', '1'); } catch(e) {}
            }
            showToast('Login successful', 'success');
            updateUIForAuth();
            initializeDriver();
        } catch(e) {
            showToast('Login failed: ' + e.message, 'error');
        }
    };

    window.logout = async function() {
        try { await apiFetch('/api/auth/logout', { method: 'POST' }); } catch(e) {}
        clearToken();
        if (driverState.pollInterval) clearInterval(driverState.pollInterval);
        if (driverState.gpsWatchId) navigator.geolocation.clearWatch(driverState.gpsWatchId);
        if (driverState.offerTimer) clearInterval(driverState.offerTimer);
        showToast('Logged out', 'success');
        updateUIForAuth();
    };

    function updateUIForAuth() {
        const token = getToken() || localStorage.getItem('vra_session_active');
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
                const name = user.full_name || user.name || user.email || 'Driver';
                const initial = String(name).charAt(0).toUpperCase();
                accInfo.innerHTML = '<div style="display:flex;align-items:center;gap:16px;">'
                    + '<div class="account-avatar">' + initial + '</div>'
                    + '<div style="flex:1;">'
                    + '<div style="font-weight:700;font-size:1.05em;">' + name + '</div>'
                    + '<div style="color:var(--muted);font-size:0.9em;">' + (user.email || '') + '</div>'
                    + '<div style="color:var(--muted);font-size:0.78em;margin-top:4px;">DRIVER</div>'
                    + '</div></div>';
            }
        } else {
            if (loginScreen) loginScreen.style.display = 'block';
            if (appMain) appMain.style.display = 'none';
            if (bottomNav) bottomNav.style.display = 'none';
        }
    }

    const driverState = {
        online: false,
        currentOffer: null,
        offerTimer: null,
        activeTrip: null,
        pollInterval: null,
        gpsWatchId: null,
        lastLocation: null
    };

    async function initializeDriver() {
        loadProfile();
        loadActiveTrip();
        loadEarnings();
        startPolling();
        startGpsTracking();
    }

    async function loadProfile() {
        try {
            const profile = await apiFetch('/api/driver/profile');
            if (profile && profile.online !== undefined) {
                driverState.online = profile.online;
                updateOnlineUI();
            }
        } catch(e) {}
    }

    window.toggleOnline = async function() {
        const newState = !driverState.online;
        try {
            await apiFetch('/api/driver/status', {
                method: 'POST',
                body: { is_online: newState }
            });
            driverState.online = newState;
            updateOnlineUI();
            showToast(newState ? 'You are ONLINE' : 'You are OFFLINE', 'success');
        } catch(e) {
            showToast('Status change failed: ' + e.message, 'error');
        }
    };

    function updateOnlineUI() {
        const label = document.getElementById('online-toggle-label');
        const status = document.getElementById('current-status');
        const statusText = document.getElementById('online-status-text');
        const btn = document.getElementById('online-toggle');
        if (driverState.online) {
            if (label) label.textContent = 'Go Offline';
            if (status) status.textContent = 'Online';
            if (statusText) statusText.textContent = 'Ready to accept rides';
            if (btn) btn.style.background = 'linear-gradient(135deg, #22C55E, #16A34A)';
        } else {
            if (label) label.textContent = 'Go Online';
            if (status) status.textContent = 'Offline';
            if (statusText) statusText.textContent = 'Go online to receive offers';
            if (btn) btn.style.background = 'linear-gradient(135deg, #CCFF00, #A8E600)';
        }
    }

    function startPolling() {
        if (driverState.pollInterval) clearInterval(driverState.pollInterval);
        driverState.pollInterval = setInterval(pollOnce, 3000);
        pollOnce();
    }

    async function pollOnce() {
        if (!getToken()) return;
        if (driverState.online && !driverState.activeTrip && !driverState.currentOffer) {
            await checkIncomingOffers();
        }
        if (driverState.activeTrip) {
            await loadActiveTrip();
        }
    }

    async function checkIncomingOffers() {
        try {
            const list = await apiFetch('/api/driver/bookings/incoming');
            const offers = Array.isArray(list) ? list 
                  : (list.offer ? [list.offer] 
                  : (list.offers || list.bookings || list.incoming || list.data || []));
            
            if (offers.length > 0 && !driverState.currentOffer) {
                showOffer(offers[0]);
            } else if (offers.length === 0 && driverState.currentOffer) {
                // Backend says no offer — clear stale UI
                driverState.currentOffer = null;
                if (driverState.offerTimer) {
                    clearInterval(driverState.offerTimer);
                    driverState.offerTimer = null;
                }
                const panel = document.getElementById('offer-panel');
                if (panel) panel.style.display = 'none';
            }
        } catch(e) {}
    }

    function showOffer(offer) {
        driverState.currentOffer = offer;
        const panel = document.getElementById('offer-panel');
        if (!panel) return;
        panel.style.display = 'block';
        const details = document.getElementById('offer-details');
        if (details) {
            const pickup = (offer.pickup && offer.pickup.address) || offer.pickupAddress || offer.pickup_address || '—';
            const dest = (offer.destination && offer.destination.address) || offer.destinationAddress || offer.destination_address || '—';
            const fare = offer.agreed_fare_minor ? (offer.agreed_fare_minor / 100).toFixed(2) : (offer.estimatedFare || offer.estimated_fare || '—');
            details.innerHTML = '<div style="margin-bottom:8px;"><strong>📍 Pickup:</strong> ' + pickup + '</div>'
                + '<div style="margin-bottom:8px;"><strong>🏁 Destination:</strong> ' + dest + '</div>'
                + '<div><strong>💰 Fare:</strong> QAR ' + fare + '</div>';
        }
        let seconds = 60;
        const timerEl = document.getElementById('offer-timer');
        if (timerEl) timerEl.textContent = seconds + 's';
        if (driverState.offerTimer) clearInterval(driverState.offerTimer);
        driverState.offerTimer = setInterval(function() {
            seconds--;
            if (timerEl) timerEl.textContent = seconds + 's';
            if (seconds <= 0) {
                clearInterval(driverState.offerTimer);
                rejectCurrentOffer(true);
            }
        }, 1000);
        if (navigator.vibrate) navigator.vibrate([200, 100, 200]);
    }

    window.acceptCurrentOffer = async function() {
        const offer = driverState.currentOffer;
        if (!offer || !offer.id) return;
        if (driverState.offerTimer) clearInterval(driverState.offerTimer);
        try {
            await apiFetch('/api/driver/bookings/' + (offer.booking_id || offer.id) + '/accept', { method: 'POST' });
            driverState.currentOffer = null;
            const panel = document.getElementById('offer-panel');
            if (panel) panel.style.display = 'none';
            showToast('Offer accepted!', 'success');
            await loadActiveTrip();
            switchTab('trip');
        } catch(e) {
            showToast('Accept failed: ' + e.message, 'error');
        }
    };

    window.rejectCurrentOffer = async function(auto) {
        const offer = driverState.currentOffer;
        if (!offer || !offer.id) return;
        if (driverState.offerTimer) clearInterval(driverState.offerTimer);
        try {
            await apiFetch('/api/driver/bookings/' + (offer.booking_id || offer.id) + '/reject', { method: 'POST' });
        } catch(e) {}
        driverState.currentOffer = null;
        const panel = document.getElementById('offer-panel');
        if (panel) panel.style.display = 'none';
        if (!auto) showToast('Offer rejected', 'success');
    };

    async function loadActiveTrip() {
        try {
            const data = await apiFetch('/api/driver/bookings/active');
            const trip = data && (data.booking || data.active || (Array.isArray(data) && data[0]));
            if (trip && trip.id) {
                driverState.activeTrip = trip;
                renderActiveTrip(trip);
            } else {
                driverState.activeTrip = null;
                renderNoActiveTrip();
            }
        } catch(e) {}
    }

    function renderActiveTrip(trip) {
        const panel = document.getElementById('active-trip-panel');
        const info = document.getElementById('active-trip-info');
        const statusEl = document.getElementById('active-trip-status');
        if (panel) panel.style.display = 'block';
        if (statusEl) {
            statusEl.textContent = String(trip.status || 'ASSIGNED').replace(/_/g,' ').toUpperCase();
            statusEl.className = 'badge ' + (trip.status || '');
        }
        if (info) {
            info.innerHTML = 'Booking #' + (trip.bookingNumber || trip.booking_number || trip.id) + '<br>'
                + '📍 ' + ((trip.pickup && trip.pickup.address) || trip.pickupAddress || trip.pickup_address || '—') + '<br>'
                + '🏁 ' + ((trip.destination && trip.destination.address) || trip.destinationAddress || trip.destination_address || '—');
        }
        renderTripTab(trip);
    }

    function renderNoActiveTrip() {
        const panel = document.getElementById('active-trip-panel');
        if (panel) panel.style.display = 'none';
        const tripTab = document.getElementById('trip-content');
        if (tripTab) {
            tripTab.innerHTML = '<div class="card"><h2>🚗 No Active Trip</h2>'
                + '<p style="color: var(--muted); text-align: center; padding: 20px;">Go online to receive offers</p></div>';
        }
    }

    function renderTripTab(trip) {
        const tripTab = document.getElementById('trip-content');
        if (!tripTab) return;
        const status = trip.status || 'assigned';
        const actions = [];

        if (status === 'driver_accepted' || status === 'assigned') {
            actions.push({ label: 'Start Driving to Pickup', endpoint: 'on-way', icon: '🚗' });
        } else if (status === 'driver_on_way') {
            actions.push({ label: 'I Have Arrived', endpoint: 'arrived', icon: '📍' });
        } else if (status === 'driver_arrived') {
            actions.push({ label: 'Vehicle Loaded', endpoint: 'loaded', icon: '📦' });
        } else if (status === 'vehicle_loaded') {
            actions.push({ label: 'Start Trip', endpoint: 'start-trip', icon: '🚀' });
        } else if (status === 'trip_in_progress') {
            actions.push({ label: 'Complete Trip', endpoint: 'complete', icon: '✅' });
        }

        // Extract addresses from nested structure
        const pickupAddr = (trip.pickup && trip.pickup.address) || trip.pickupAddress || trip.pickup_address || '—';
        const destAddr = (trip.destination && trip.destination.address) || trip.destinationAddress || trip.destination_address || '—';
        const fare = trip.agreed_fare_minor ? 'QAR ' + (trip.agreed_fare_minor / 100).toFixed(2) : '';
        const bookingNum = trip.booking_number || trip.bookingNumber || trip.id;

        // Determine route target based on status
        // Before loaded: driver goes to pickup
        // After loaded (start-trip, in-progress): driver goes to destination
        const goingToPickup = ['assigned', 'driver_accepted', 'driver_on_way', 'driver_arrived'].includes(status);
        const target = goingToPickup ? trip.pickup : trip.destination;
        const targetLabel = goingToPickup ? 'Pickup' : 'Destination';

        let html = '<div class="card">'
            + '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:16px;">'
            + '<div>'
            + '<h2 style="margin:0;font-size:1.1em;">Booking #' + bookingNum + '</h2>'
            + (fare ? '<div style="color:var(--primary);font-weight:700;margin-top:4px;">' + fare + '</div>' : '')
            + '</div>'
            + '<span class="badge ' + status + '">' + status.replace(/_/g,' ').toUpperCase() + '</span>'
            + '</div>'
            + '<div style="font-size:0.9em;color:var(--muted);margin-bottom:16px;line-height:1.6;">'
            + '<div>📍 <strong>From:</strong> ' + pickupAddr + '</div>'
            + '<div style="margin-top:4px;">🏁 <strong>To:</strong> ' + destAddr + '</div>'
            + '</div>';

        // Add map container (if pickup & destination have coords)
        if (target && target.lat && target.lng) {
            html += '<div id="driver-trip-map" style="height:300px;width:100%;border-radius:14px;margin-bottom:16px;border:1px solid var(--border);"></div>';
            html += '<div id="driver-trip-info" style="padding:10px 14px;background:var(--input-bg);border-radius:12px;margin-bottom:12px;font-size:0.9em;">'
                 + '<span style="color:var(--muted);">Calculating route...</span>'
                 + '</div>';
        }

        // Action buttons
        if (actions.length > 0) {
            actions.forEach(function(a) {
                html += '<button class="btn" style="margin-top:12px;" onclick="progressTrip(\'' + a.endpoint + '\')">'
                    + a.icon + ' ' + a.label + '</button>';
            });
        }

        html += '<button class="btn danger" style="margin-top:12px;" onclick="cancelActiveTrip()">Cancel Trip</button>';
        html += '</div>';

        tripTab.innerHTML = html;

        // Initialize map after DOM update
        if (target && target.lat && target.lng) {
            setTimeout(function() { initDriverTripMap(trip, target, targetLabel); }, 300);
        }
    }

    // ═══ DRIVER TRIP MAP ═══
    let _driverTripMap = null;
    let _driverTripMarker = null;
    let _driverTargetMarker = null;
    let _driverRouteLine = null;
    let _driverRouteInterval = null;

    function initDriverTripMap(trip, target, targetLabel) {
        const mapEl = document.getElementById('driver-trip-map');
        if (!mapEl) return;

        // Destroy old map if exists
        if (_driverTripMap) {
            try { _driverTripMap.remove(); } catch(e) {}
            _driverTripMap = null;
        }
        if (_driverRouteInterval) {
            clearInterval(_driverRouteInterval);
            _driverRouteInterval = null;
        }

        // Init map centered between driver and target
        const targetCoords = [target.lat, target.lng];
        _driverTripMap = L.map('driver-trip-map').setView(targetCoords, 13);
        L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
            attribution: '© OpenStreetMap'
        }).addTo(_driverTripMap);

        // Car icon for driver
        const carSvg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="#FF9F1C" stroke="#0a0a0a" stroke-width="2"><path d="M10 17h4V5H2v12h3m10 0h4m-4 0a3 3 0 1 1-6 0m6 0a3 3 0 1 0 6 0M9 17a3 3 0 1 1-6 0m6 0a3 3 0 1 0 6 0"/><path d="M22 17h-4V9h3l3 4v4z"/></svg>';
        const carIcon = L.icon({
            iconUrl: 'data:image/svg+xml;utf8,' + encodeURIComponent(carSvg),
            iconSize: [40, 40],
            iconAnchor: [20, 20]
        });

        // Target marker (pickup or destination)
        _driverTargetMarker = L.marker(targetCoords, {
            icon: L.divIcon({
                className: 'driver-target-marker',
                html: '<div style="background:#FF9F1C;width:16px;height:16px;border-radius:50%;border:3px solid #fff;box-shadow:0 2px 8px rgba(0,0,0,0.3);"></div>',
                iconSize: [22, 22]
            })
        }).addTo(_driverTripMap);
        _driverTargetMarker.bindPopup('📍 ' + targetLabel + ': ' + (target.address || ''));

        // Driver marker (car) — will update position
        _driverTripMarker = L.marker(targetCoords, {icon: carIcon}).addTo(_driverTripMap);
        _driverTripMarker.bindPopup('🚗 You');

        // Route line
        _driverRouteLine = L.polyline([], {color: '#FF9F1C', weight: 6, opacity: 0.9}).addTo(_driverTripMap);

        // Fetch driver GPS from backend and draw route
        function updateDriverRoute() {
            fetch('/api/driver/profile', { credentials: 'include' })
                .then(r => r.json())
                .then(profile => {
                    const d = profile.driver || profile.profile?.driver || {};
                    const lat = d.last_gps_lat || profile.driver?.last_gps_lat;
                    const lng = d.last_gps_lng || profile.driver?.last_gps_lng;
                    if (!lat || !lng) return;
                    
                    const driverCoords = [lat, lng];
                    _driverTripMarker.setLatLng(driverCoords);
                    
                    // Fetch OSRM route
                    const url = 'https://router.project-osrm.org/route/v1/driving/' +
                        lng + ',' + lat + ';' + target.lng + ',' + target.lat +
                        '?overview=full&geometries=geojson';
                    
                    fetch(url).then(r => r.json()).then(data => {
                        if (data.routes && data.routes[0]) {
                            const coords = data.routes[0].geometry.coordinates.map(c => [c[1], c[0]]);
                            _driverRouteLine.setLatLngs(coords);
                            
                            const distKm = (data.routes[0].distance / 1000).toFixed(1);
                            const etaMin = Math.ceil(data.routes[0].duration / 60);
                            const info = document.getElementById('driver-trip-info');
                            if (info) {
                                info.innerHTML = '<div style="display:flex;justify-content:space-between;align-items:center;">'
                                    + '<span><strong style="color:var(--primary);font-size:1.2em;">' + distKm + ' km</strong> to ' + targetLabel + '</span>'
                                    + '<span style="color:var(--muted);">ETA: ' + etaMin + ' min</span>'
                                    + '</div>';
                            }
                        }
                    }).catch(e => console.warn('Route fetch:', e));
                })
                .catch(e => console.warn('GPS fetch:', e));
        }

        updateDriverRoute();
        _driverRouteInterval = setInterval(updateDriverRoute, 5000);
    }

    window.progressTrip = async function(endpoint) {
        if (!driverState.activeTrip || !driverState.activeTrip.id) return;
        try {
            const body = {};
            // For 'arrived', add manual_fallback if GPS fails
            if (endpoint === 'arrived') {
                body.manual_fallback = true;
                body.reason = 'Driver confirmed arrival manually (GPS may be inaccurate)';
            }
            await apiFetch('/api/driver/bookings/' + driverState.activeTrip.id + '/' + endpoint, { 
                method: 'POST', 
                body: body 
            });
            showToast('Status updated', 'success');
            await loadActiveTrip();
        } catch(e) {
            // If manual_fallback failed, retry with error message
            if (endpoint === 'arrived' && e.message.includes('gps_not_near_pickup')) {
                showToast('GPS too far from pickup. Move closer or check GPS.', 'error');
            } else {
                showToast('Update failed: ' + e.message, 'error');
            }
        }
    };

    window.cancelActiveTrip = async function() {
        if (!driverState.activeTrip || !driverState.activeTrip.id) return;
        if (!confirm('Cancel this trip?')) return;
        try {
            await apiFetch('/api/driver/bookings/' + driverState.activeTrip.id + '/cancel', { method: 'POST', body: { reason: 'driver_cancelled' } });
            showToast('Trip cancelled', 'success');
            await loadActiveTrip();
        } catch(e) {
            showToast('Cancel failed: ' + e.message, 'error');
        }
    };

    async function loadEarnings() {
        try {
            const data = await apiFetch('/api/driver/earnings');
            if (data) {
                const today = data.today || 0;
                const week = data.week || 0;
                const total = data.total || 0;
                const rides = data.todayRides || 0;
                const set = function(id, v) { const el = document.getElementById(id); if (el) el.textContent = v; };
                set('today-rides', rides);
                set('today-earnings', 'QAR ' + today);
                set('earnings-today', 'QAR ' + today);
                set('earnings-week', 'QAR ' + week);
                set('earnings-total', 'QAR ' + (total / 100).toFixed(2)); await loadRecentTrips();
            }
        } catch(e) {}
    }

    async function loadRecentTrips() {
        const container = document.getElementById('trip-history');
        if (!container) return;
        try {
            const resp = await fetch('/api/driver/bookings/history', { credentials: 'include' });
            let trips = [];
            if (resp.ok) {
                const data = await resp.json();
                trips = data.bookings || (Array.isArray(data) ? data : []);
            }
            if (!trips.length) {
                container.innerHTML = '<div class="empty-compact"><div class="empty-compact-icon">📋</div><div class="empty-compact-body"><div class="empty-compact-title">No trips yet</div><div class="empty-compact-sub">Completed trips will appear here</div></div></div>';
                return;
            }
            container.innerHTML = trips.slice(0, 10).map(function(b) {
                const bNum = b.booking_number || b.id;
                const pAddr = b.pickup_address || '—';
                const dAddr = b.destination_address || '—';
                const fare = b.agreed_fare_minor ? (b.agreed_fare_minor / 100).toFixed(2) : '—';
                const date = b.completed_at || b.created_at;
                const dateStr = date ? new Date(date).toLocaleDateString() : '';
                return '<div class="list-item"><div class="list-item-header"><div class="list-item-title">#' + bNum + '</div><span class="badge trip_completed">COMPLETED</span></div><div style="color:var(--muted);font-size:0.85em;margin-top:4px;">📍 ' + pAddr + ' → 🏁 ' + dAddr + '</div><div style="display:flex;justify-content:space-between;margin-top:8px;"><span style="color:var(--primary);font-weight:700;">QAR ' + fare + '</span>' + (dateStr ? '<span style="color:var(--muted);font-size:0.8em;">' + dateStr + '</span>' : '') + '</div></div>';
            }).join('');
        } catch(e) {
            container.innerHTML = '<p style="color:var(--danger);padding:20px;">Failed to load</p>';
        }
    }

    function startGpsTracking() {
        if (!navigator.geolocation) return;
        if (driverState.gpsWatchId) navigator.geolocation.clearWatch(driverState.gpsWatchId);
        driverState.gpsWatchId = navigator.geolocation.watchPosition(
            function(pos) {
                driverState.lastLocation = { lat: pos.coords.latitude, lng: pos.coords.longitude };
                sendLocation();
            },
            function(err) {},
            { enableHighAccuracy: true, maximumAge: 5000, timeout: 10000 }
        );
        setInterval(sendLocation, 10000);
    }

    function sendLocation() {
        if (!driverState.lastLocation || !getToken()) return;
        apiFetch('/api/driver/location', {
            method: 'POST',
            body: driverState.lastLocation
        }).catch(function() {});
    }

    window.toggleTheme = function() {
        const cur = document.documentElement.getAttribute('data-theme') || 'dark';
        const next = cur === 'dark' ? 'light' : 'dark';
        document.documentElement.setAttribute('data-theme', next);
        try { localStorage.setItem('vra_theme', next); } catch(e) {}
    };

    window.toggleLanguage = function() {
        const cur = document.documentElement.getAttribute('dir') === 'rtl' ? 'ar' : 'en';
        const next = cur === 'ar' ? 'en' : 'ar';
        document.documentElement.setAttribute('dir', next === 'ar' ? 'rtl' : 'ltr');
        document.documentElement.setAttribute('lang', next);
        try { localStorage.setItem('vra_lang', next); } catch(e) {}
    };

    // ─── Socket.io events ───
    let driverSocket = null;
    if (typeof io !== 'undefined') {
        driverSocket = io();
        driverSocket.on('driver_offer', function(data) {
            if (!driverState.currentOffer && driverState.online) {
                showOffer(data);
            }
        });
        driverSocket.on('booking_cancelled', function(data) {
            showToast('Booking cancelled by customer', 'error');
            loadActiveTrip();
        });
    }

    // ─── Initialize ───
    document.addEventListener('DOMContentLoaded', function() {
        try {
            const th = localStorage.getItem('vra_theme');
            if (th) document.documentElement.setAttribute('data-theme', th);
            const lang = localStorage.getItem('vra_lang');
            if (lang) {
                document.documentElement.setAttribute('dir', lang === 'ar' ? 'rtl' : 'ltr');
                document.documentElement.setAttribute('lang', lang);
            }
        } catch(e) {}
        updateUIForAuth();
        if (getToken() || localStorage.getItem('vra_session_active')) {
            initializeDriver();
        }
    });
})();