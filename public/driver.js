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
            const pickup = offer.pickupAddress || offer.pickup_address || '—';
            const dest = offer.destinationAddress || offer.destination_address || '—';
            const fare = offer.estimatedFare || offer.estimated_fare || '—';
            details.innerHTML = '<div style="margin-bottom:8px;"><strong>📍 Pickup:</strong> ' + pickup + '</div>'
                + '<div style="margin-bottom:8px;"><strong>🏁 Destination:</strong> ' + dest + '</div>'
                + '<div><strong>💰 Fare:</strong> QAR ' + fare + '</div>';
        }
        let seconds = 20;
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
                + '📍 ' + (trip.pickupAddress || trip.pickup_address || '—') + '<br>'
                + '🏁 ' + (trip.destinationAddress || trip.destination_address || '—');
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

        let html = '<div class="card">'
            + '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:16px;">'
            + '<h2 style="margin:0;">Active Trip</h2>'
            + '<span class="badge ' + status + '">' + status.replace(/_/g,' ').toUpperCase() + '</span>'
            + '</div>'
            + '<div style="font-size:0.9em;color:var(--muted);margin-bottom:16px;">'
            + '📍 <strong>From:</strong> ' + (trip.pickupAddress || trip.pickup_address || '—') + '<br>'
            + '🏁 <strong>To:</strong> ' + (trip.destinationAddress || trip.destination_address || '—')
            + '</div>';

        if (actions.length > 0) {
            actions.forEach(function(a) {
                html += '<button class="btn" style="margin-top:12px;" onclick="progressTrip(\'' + a.endpoint + '\')">'
                    + a.icon + ' ' + a.label + '</button>';
            });
        }

        html += '<button class="btn danger" style="margin-top:12px;" onclick="cancelActiveTrip()">Cancel Trip</button>';
        html += '</div>';

        tripTab.innerHTML = html;
    }

    window.progressTrip = async function(endpoint) {
        if (!driverState.activeTrip || !driverState.activeTrip.id) return;
        try {
            await apiFetch('/api/driver/bookings/' + driverState.activeTrip.id + '/' + endpoint, { method: 'POST' });
            showToast('Status updated', 'success');
            await loadActiveTrip();
        } catch(e) {
            showToast('Update failed: ' + e.message, 'error');
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
                set('earnings-total', 'QAR ' + total);
            }
        } catch(e) {}
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