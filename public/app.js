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
            if (data.length === 0) { list.innerHTML = '<p style="text-align:center; color:#9ca3af; margin:10px 0;">No vehicles added.</p>'; return; }
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
            if (data.length === 0) { list.innerHTML = '<p style="text-align:center; color:#9ca3af; margin:10px 0;">No saved places.</p>'; return; }
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
        if(container) container.style.display = 'block';
        
        if(!trackMap) {
            trackMap = L.map('live-tracking-map').setView([25.2854, 51.5310], 14);
            L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png').addTo(trackMap);
        }
        setTimeout(() => trackMap.invalidateSize(), 200);
        if(localSocket) localSocket.emit('join_trip', { bookingId, role: 'customer' });
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
})();
