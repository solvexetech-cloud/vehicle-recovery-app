// ==========================================================
// VEHICLE RECOVERY APP - Frontend (vanilla JS)
// ==========================================================

const API = {
  async req(method, path, body) {
    const opts = {
      method,
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include'
    };
    if (body) opts.body = JSON.stringify(body);
    const res = await fetch(path, opts);
    const text = await res.text();
    let data = null;
    try { data = JSON.parse(text); } catch (_) { data = { raw: text }; }
    return { status: res.status, ok: res.ok, data };
  },
  get(path) { return this.req('GET', path); },
  post(path, body) { return this.req('POST', path, body); },
  patch(path, body) { return this.req('PATCH', path, body); },
  del(path) { return this.req('DELETE', path); }
};

// ---------- Toast notifications ----------
function toast(msg, type = 'info') {
  const colors = { info: '#3b82f6', success: '#10b981', error: '#ef4444', warn: '#f59e0b' };
  const el = document.createElement('div');
  el.style.cssText = `position:fixed;bottom:20px;right:20px;padding:14px 20px;background:${colors[type]};color:white;border-radius:8px;box-shadow:0 4px 12px rgba(0,0,0,0.3);z-index:9999;font-weight:500;max-width:380px;`;
  el.textContent = msg;
  document.body.appendChild(el);
  setTimeout(() => el.remove(), 4000);
}

// ---------- Auth helpers ----------
async function getMe() {
  const res = await API.get('/api/auth/me');
  return res.ok ? res.data.user : null;
}
async function logout() {
  await API.post('/api/auth/logout');
  window.location.href = '/';
}
function showError(elId, msg) {
  const el = document.getElementById(elId);
  if (el) { el.textContent = msg; el.classList.remove('hidden'); }
}

// ---------- Landing page ----------
async function initLanding() {
  const me = await getMe();
  if (me) {
    // Already logged in → redirect to appropriate dashboard
    if (me.role === 'customer') window.location.href = '/customer.html';
    else if (me.role === 'driver') window.location.href = '/driver.html';
    else if (me.role === 'agency') window.location.href = '/agency.html';
    else if (me.role === 'country_admin' || me.role === 'super_admin') window.location.href = '/admin.html';
    return;
  }

  // Health check
  const health = await API.get('/health');
  if (health.ok) {
    document.getElementById('health-status').textContent = `v${health.data.version} · ${health.data.database} · ${health.data.countries} countries`;
    document.getElementById('health-status').className = 'value success';
  }

  // Toggle login/register
  document.getElementById('show-register').addEventListener('click', (e) => {
    e.preventDefault();
    document.getElementById('login-card').classList.add('hidden');
    document.getElementById('register-card').classList.remove('hidden');
  });
  document.getElementById('show-login').addEventListener('click', (e) => {
    e.preventDefault();
    document.getElementById('register-card').classList.add('hidden');
    document.getElementById('login-card').classList.remove('hidden');
  });

  // Login form
  document.getElementById('login-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const identifier = document.getElementById('login-identifier').value;
    const password = document.getElementById('login-password').value;
    const res = await API.post('/api/auth/login', { identifier, password });
    if (res.ok) {
      toast('Login successful', 'success');
      setTimeout(() => window.location.reload(), 500);
    } else if (res.data.error === 'mfa_required') {
      const code = prompt('MFA code required (6 digits):');
      if (code) {
        const res2 = await API.post('/api/auth/login', { identifier, password, mfa_code: code });
        if (res2.ok) { toast('Login successful', 'success'); setTimeout(() => window.location.reload(), 500); }
        else showError('login-error', res2.data.error || 'Login failed');
      }
    } else {
      showError('login-error', res.data.error || res.data.message || 'Login failed');
    }
  });

  // Register form
  document.getElementById('register-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const body = {
      role: document.getElementById('reg-role').value,
      full_name: document.getElementById('reg-full-name').value,
      email: document.getElementById('reg-email').value,
      password: document.getElementById('reg-password').value,
      country_code: document.getElementById('reg-country').value
    };
    const res = await API.post('/api/auth/register', body);
    if (res.status === 201) {
      document.getElementById('register-form').classList.add('hidden');
      const info = document.getElementById('verify-info');
      info.classList.remove('hidden');
      if (res.data.dev_verify_token) {
        document.getElementById('verify-link').innerHTML =
          `<a href="/api/auth/verify-email?token=${res.data.dev_verify_token}" target="_blank" class="btn">Verify Email Now (dev)</a>`;
      }
    } else {
      showError('register-error', res.data.error || res.data.message || 'Registration failed');
    }
  });

  // Load countries dropdown
  const countries = await API.get('/api/countries');
  if (countries.ok) {
    const sel = document.getElementById('reg-country');
    sel.innerHTML = countries.data.countries.map((c) =>
      `<option value="${c.code}">${c.name_en} (${c.code})</option>`
    ).join('');
  }
}

// ---------- Customer dashboard ----------
async function initCustomer() {
  const me = await getMe();
  if (!me || me.role !== 'customer') { window.location.href = '/'; return; }

  document.getElementById('user-name').textContent = me.full_name;

  // Load profile
  const profile = await API.get('/api/customer/profile');
  if (profile.ok) {
    document.getElementById('country-info').textContent =
      `${profile.data.country.code} · ${profile.data.country.currency_code} · ${profile.data.vehicle_count} vehicles · ${profile.data.destination_count} destinations`;
  }

  // Load vehicles
  async function refreshVehicles() {
    const res = await API.get('/api/customer/vehicles');
    const tb = document.getElementById('vehicles-tbody');
    if (!res.ok) { tb.innerHTML = '<tr><td colspan="5">Error</td></tr>'; return; }
    if (res.data.vehicles.length === 0) {
      tb.innerHTML = '<tr><td colspan="5" style="color:var(--muted);">No vehicles yet</td></tr>';
    } else {
      tb.innerHTML = res.data.vehicles.map((v) => `
        <tr>
          <td>${v.category}</td>
          <td>${v.registration_number}</td>
          <td>${v.make || '-'} ${v.model || ''}</td>
          <td>${v.is_default ? '<span class="badge payment_completed">default</span>' : ''}</td>
          <td><button class="btn danger small" onclick="deleteVehicle(${v.id})">Delete</button></td>
        </tr>`).join('');
    }
  }

  window.deleteVehicle = async (id) => {
    if (!confirm('Delete this vehicle?')) return;
    const res = await API.del('/api/customer/vehicles/' + id);
    if (res.ok) { toast('Vehicle deleted', 'success'); refreshVehicles(); }
    else toast(res.data.error || 'Failed', 'error');
  };

  document.getElementById('add-vehicle-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const body = {
      category: document.getElementById('v-category').value,
      registration_number: document.getElementById('v-plate').value,
      make: document.getElementById('v-make').value || null,
      model: document.getElementById('v-model').value || null
    };
    const res = await API.post('/api/customer/vehicles', body);
    if (res.status === 201) { toast('Vehicle added', 'success'); e.target.reset(); refreshVehicles(); }
    else toast(res.data.error || 'Failed', 'error');
  });

  // Load bookings
  async function refreshBookings() {
    const res = await API.get('/api/customer/bookings');
    const tb = document.getElementById('bookings-tbody');
    if (!res.ok) return;
    if (res.data.bookings.length === 0) {
      tb.innerHTML = '<tr><td colspan="6" style="color:var(--muted);">No bookings yet</td></tr>';
    } else {
      tb.innerHTML = res.data.bookings.map((b) => `
        <tr>
          <td><code>${b.booking_number}</code></td>
          <td>${b.service_type}</td>
          <td><span class="badge ${b.status}">${b.status}</span></td>
          <td>${(b.agreed_fare_minor / 100).toFixed(2)} ${b.currency_code}</td>
          <td>${new Date(b.created_at).toLocaleString()}</td>
          <td>
            <button class="btn secondary small" onclick="trackBooking(${b.id})">Track</button>
          </td>
        </tr>`).join('');
    }
  }

  window.trackBooking = async (id) => {
    const res = await API.get(`/api/customer/bookings/${id}/tracking`);
    if (!res.ok) { toast('Failed to load', 'error'); return; }
    const d = res.data;
    const div = document.getElementById('tracking-details');
    div.innerHTML = `
      <div class="grid cols-3">
        <div class="stat"><div class="label">Status</div><div class="value"><span class="badge ${d.booking.status}">${d.booking.status}</span></div></div>
        <div class="stat"><div class="label">Fare</div><div class="value">${(d.booking.agreed_fare_minor / 100).toFixed(2)} ${d.booking.currency_code}</div></div>
        <div class="stat"><div class="label">Pickup</div><div class="value" style="font-size:1em;">${d.booking.pickup.address || (d.booking.pickup.lat + ',' + d.booking.pickup.lng)}</div></div>
      </div>
      ${d.driver ? `
        <div class="info"><strong>Driver:</strong> ${d.driver.full_name} · ⭐ ${d.driver.rating_avg.toFixed(1)} (${d.driver.rating_count})</div>
      ` : '<div class="info">Waiting for driver assignment...</div>'}
      <h3 style="margin-top:20px;">Timeline</h3>
      <ul class="timeline">
        ${d.timeline.map((t) => `<li class="completed"><strong>${t.to_status}</strong> · ${new Date(t.created_at).toLocaleString()}</li>`).join('')}
      </ul>
      ${['created', 'searching'].includes(d.booking.status) ? `
        <button class="btn warning" onclick="dispatchBooking(${id})">Start Dispatch (find driver)</button>
      ` : ''}
      ${!['trip_completed', 'payment_completed', 'cancelled', 'disputed'].includes(d.booking.status) ? `
        <button class="btn danger" onclick="cancelBooking(${id})">Cancel Booking</button>
      ` : ''}
      ${d.booking.status === 'trip_completed' ? `
        <button class="btn success" onclick="payCash(${id})">Mark Cash Paid</button>
      ` : ''}
    `;
  };

  window.dispatchBooking = async (id) => {
    const res = await API.post(`/api/customer/bookings/${id}/dispatch`);
    if (res.ok) {
      const s = res.data.dispatch.status;
      if (s === 'offer_created' || s === 'pending_offer') toast('Offer sent to driver', 'success');
      else if (s === 'no_driver') toast('No driver available', 'warn');
      else toast(s, 'info');
      setTimeout(() => trackBooking(id), 500);
    } else toast(res.data.error || 'Failed', 'error');
  };

  window.cancelBooking = async (id) => {
    const reason = prompt('Cancellation reason (optional):') || 'Customer cancelled';
    const res = await API.post(`/api/customer/bookings/${id}/cancel`, { reason });
    if (res.ok) {
      toast(`Cancelled${res.data.booking.cancellation_fee_minor > 0 ? ` (fee ${res.data.booking.cancellation_fee_minor / 100})` : ''}`, 'success');
      refreshBookings();
    } else toast(res.data.error || 'Failed', 'error');
  };

  window.payCash = async (id) => {
    const res = await API.post(`/api/customer/bookings/${id}/payment/cash-paid`, {});
    if (res.status === 201) { toast('Payment recorded', 'success'); refreshBookings(); }
    else toast(res.data.error || 'Failed', 'error');
  };

  // New booking form
  document.getElementById('new-booking-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const body = {
      service_type: 'towing',
      service_level: 'normal',
      pickup: { lat: 25.3, lng: 51.5, address: document.getElementById('bk-pickup').value },
      destination: { lat: 25.3, lng: 51.55, address: document.getElementById('bk-destination').value },
      vehicle: {
        category: 'suv',
        registration_number: document.getElementById('bk-plate').value
      }
    };
    const est = await API.post('/api/customer/bookings/estimate', body);
    if (!est.ok) { toast(est.data.error || 'Estimate failed', 'error'); return; }
    const total = est.data.fare_breakdown.total_minor;
    if (!confirm(`Fare: ${(total / 100).toFixed(2)} ${est.data.currency_code}\n\nConfirm booking?`)) return;
    body.agreed_fare_minor = total;
    const res = await API.post('/api/customer/bookings', body);
    if (res.status === 201) {
      toast(`Booking ${res.data.booking.booking_number} created`, 'success');
      e.target.reset();
      refreshBookings();
    } else toast(res.data.error || 'Failed', 'error');
  });

  await Promise.all([refreshVehicles(), refreshBookings()]);
}

// ---------- Driver dashboard ----------
async function initDriver() {
  const me = await getMe();
  if (!me || me.role !== 'driver') { window.location.href = '/'; return; }
  document.getElementById('user-name').textContent = me.full_name;

  async function pollOffer() {
    const res = await API.get('/api/driver/bookings/incoming');
    const div = document.getElementById('offer-div');
    if (res.ok && res.data.offer) {
      const o = res.data.offer;
      div.innerHTML = `
        <div class="card" style="border-color:var(--warning);">
          <h2>🔔 New Offer</h2>
          <div class="grid cols-2">
            <div class="stat"><div class="label">Booking</div><div class="value" style="font-size:1em;"><code>${o.booking_number}</code></div></div>
            <div class="stat"><div class="label">Fare</div><div class="value">${(o.agreed_fare_minor / 100).toFixed(2)} ${o.currency_code}</div></div>
            <div class="stat"><div class="label">Distance to pickup</div><div class="value">${o.distance_km} km</div></div>
            <div class="stat"><div class="label">Expires in</div><div class="value" id="countdown">${Math.round((new Date(o.expires_at) - new Date()) / 1000)}s</div></div>
          </div>
          <div class="info"><strong>Pickup:</strong> ${o.pickup.address || (o.pickup.lat + ',' + o.pickup.lng)}</div>
          <div class="info"><strong>Destination:</strong> ${o.destination.address || (o.destination.lat + ',' + o.destination.lng)}</div>
          <div class="row">
            <button class="btn success" onclick="acceptOffer(${o.booking_id})">✓ Accept</button>
            <button class="btn danger" onclick="rejectOffer(${o.booking_id})">✗ Reject</button>
          </div>
        </div>`;
      // Countdown
      const cd = document.getElementById('countdown');
      if (cd) {
        const iv = setInterval(() => {
          const sec = Math.round((new Date(o.expires_at) - new Date()) / 1000);
          if (sec <= 0) { clearInterval(iv); cd.textContent = 'expired'; }
          else cd.textContent = sec + 's';
        }, 1000);
      }
    } else {
      div.innerHTML = '<div class="info">No active offers. Waiting...</div>';
    }
  }

  window.acceptOffer = async (id) => {
    const res = await API.post(`/api/driver/bookings/${id}/accept`);
    if (res.ok) { toast('Accepted! Loading trip...', 'success'); pollOffer(); refreshActive(); }
    else toast(res.data.error || 'Failed', 'error');
  };
  window.rejectOffer = async (id) => {
    const res = await API.post(`/api/driver/bookings/${id}/reject`);
    if (res.ok) { toast('Rejected', 'info'); pollOffer(); }
    else toast(res.data.error || 'Failed', 'error');
  };

  async function refreshActive() {
    const res = await API.get('/api/driver/bookings/active');
    const div = document.getElementById('active-div');
    if (res.ok && res.data.booking) {
      const b = res.data.booking;
      const nextBtn = {
        assigned: ['on-way', 'Start Driving'],
        driver_on_way: ['arrived', 'Mark Arrived'],
        driver_arrived: ['loaded', 'Mark Vehicle Loaded'],
        vehicle_loaded: ['start-trip', 'Start Trip'],
        trip_in_progress: ['complete', 'Complete Trip']
      }[b.status];
      div.innerHTML = `
        <div class="card" style="border-color:var(--success);">
          <h2>Active Trip: <span class="badge ${b.status}">${b.status}</span></h2>
          <div class="grid cols-3">
            <div class="stat"><div class="label">Booking</div><div class="value" style="font-size:1em;"><code>${b.booking_number}</code></div></div>
            <div class="stat"><div class="label">Fare</div><div class="value">${(b.agreed_fare_minor / 100).toFixed(2)} ${b.currency_code}</div></div>
            <div class="stat"><div class="label">Service</div><div class="value" style="font-size:1em;">${b.service_type}</div></div>
          </div>
          ${nextBtn ? `<button class="btn success" onclick="tripAction(${b.id}, '${nextBtn[0]}')">${nextBtn[1]}</button>` : ''}
        </div>`;
    } else {
      div.innerHTML = '';
    }
  }

  window.tripAction = async (id, action) => {
    let body = {};
    if (action === 'arrived') {
      body = { manual_fallback: true, reason: 'Driver UI manual' };
    }
    const res = await API.post(`/api/driver/bookings/${id}/${action}`, body);
    if (res.ok) { toast('OK', 'success'); refreshActive(); }
    else toast(res.data.error || 'Failed', 'error');
  };

  // GPS update
  setInterval(async () => {
    if (navigator.geolocation) {
      navigator.geolocation.getCurrentPosition(async (pos) => {
        await API.post('/api/driver/location', { lat: pos.coords.latitude, lng: pos.coords.longitude });
      }, () => {});
    }
  }, 30000);

  await Promise.all([pollOffer(), refreshActive()]);
  setInterval(pollOffer, 5000);
  setInterval(refreshActive, 5000);
}

// ---------- Admin dashboard ----------
async function initAdmin() {
  const me = await getMe();
  if (!me || !['country_admin', 'super_admin'].includes(me.role)) { window.location.href = '/'; return; }
  document.getElementById('user-name').textContent = `${me.full_name} (${me.role})`;

  // Countries list
  const countries = await API.get('/api/super/countries');
  if (countries.ok) {
    const tb = document.getElementById('countries-tbody');
    tb.innerHTML = countries.data.countries.map((c) => `
      <tr>
        <td><strong>${c.code}</strong></td>
        <td>${c.name_en}</td>
        <td>${c.currency_code}</td>
        <td>${c.is_active ? '<span class="badge payment_completed">active</span>' : '<span class="badge cancelled">inactive</span>'}</td>
        <td>${c.services_enabled}</td>
        <td>${c.country_admins}</td>
      </tr>`).join('');
  }

  // Analytics
  if (me.role === 'super_admin') {
    document.getElementById('analytics-card').classList.remove('hidden');
    const analytics = await API.get('/api/super/analytics');
    if (analytics.ok) {
      const tb = document.getElementById('analytics-tbody');
      tb.innerHTML = analytics.data.countries.map((c) => `
        <tr>
          <td><strong>${c.code}</strong></td>
          <td>${c.total_bookings}</td>
          <td>${c.completed_bookings}</td>
          <td>${c.disputed_bookings}</td>
          <td>${(c.gross_minor / 100).toFixed(2)}</td>
          <td>${(c.commission_minor / 100).toFixed(2)}</td>
          <td>${c.total_drivers} / ${c.total_vehicles}</td>
        </tr>`).join('');
    }
  }

  // Reports
  const reports = await API.get('/api/admin/reports/bookings');
  if (reports.ok) {
    const tb = document.getElementById('reports-tbody');
    if (reports.data.rows.length === 0) {
      tb.innerHTML = '<tr><td colspan="6" style="color:var(--muted);">No bookings yet</td></tr>';
    } else {
      tb.innerHTML = reports.data.rows.slice(0, 50).map((r) => `
        <tr>
          <td><code>${r.booking_number}</code></td>
          <td>${r.service_type}</td>
          <td><span class="badge ${r.status}">${r.status}</span></td>
          <td>${(r.agreed_fare_minor / 100).toFixed(2)} ${r.currency_code}</td>
          <td>${r.driver_name || '-'}</td>
          <td>${new Date(r.created_at).toLocaleString()}</td>
        </tr>`).join('');
    }
    document.getElementById('reports-count').textContent = `${reports.data.total} bookings`;
  }
}

// ---------- Router ----------
document.addEventListener('DOMContentLoaded', () => {
  const path = window.location.pathname;
  if (path === '/' || path === '/index.html') initLanding();
  else if (path === '/customer.html') initCustomer();
  else if (path === '/driver.html') initDriver();
  else if (path === '/admin.html') initAdmin();
});

// Logout buttons
document.addEventListener('click', (e) => {
  if (e.target.id === 'logout-btn') logout();
});