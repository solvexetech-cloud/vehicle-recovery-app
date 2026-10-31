// Auto-seed demo data on first startup
const { hashPasswordSync } = require('../auth');

async function ensureDemoData(db) {
    try {
        // Only seed if demo customer doesn't exist
        const demoCustomer = db.prepare("SELECT id FROM users WHERE email = 'demo1@example.com'").get();
        if (demoCustomer) {
            console.log('⏭️  Demo users already exist — skipping seed');
            return;
        }

        console.log('🌱 Seeding demo data...');
        
        const qatar = db.prepare("SELECT id FROM countries WHERE code = 'QA'").get();
        const countryId = qatar ? qatar.id : 1;
        const now = new Date().toISOString();
        
        const demoPass = await hashPasswordSync('DemoPass1234');
        const driverPass = await hashPasswordSync('DriverPass1234');
        const agencyPass = await hashPasswordSync('AgencyPass1234');

        // 1. Customer (demo1)
        const customerResult = db.prepare(
            "INSERT OR IGNORE INTO users (email, password_hash, role, status, full_name, country_id, created_at) VALUES (?, ?, 'customer', 'active', 'Demo Customer', ?, ?)"
        ).run('demo1@example.com', demoPass, countryId, now);
        console.log('   ✅ Customer (id=' + customerResult.lastInsertRowid + ')');

        // 2. Agency user + agency (CORRECTED for legal_name/display_name)
        const agencyUserResult = db.prepare(
            "INSERT OR IGNORE INTO users (email, password_hash, role, status, full_name, country_id, created_at) VALUES (?, ?, 'agency', 'active', 'Demo Agency', ?, ?)"
        ).run('agency1@example.com', agencyPass, countryId, now);
        const agencyUserId = agencyUserResult.lastInsertRowid;
        
        const agencyResult = db.prepare(
            "INSERT OR IGNORE INTO agencies (country_id, user_id, legal_name, display_name, contact_email, status, approved_at, created_at) VALUES (?, ?, 'Demo Agency LLC', 'Demo Agency', 'agency1@example.com', 'approved', ?, ?)"
        ).run(countryId, agencyUserId, now, now);
        const agencyId = agencyResult.lastInsertRowid;
        console.log('   ✅ Agency (id=' + agencyId + ')');

        // 3. Driver user + profile
        const driverUserResult = db.prepare(
            "INSERT OR IGNORE INTO users (email, password_hash, role, status, full_name, country_id, created_at) VALUES (?, ?, 'driver', 'active', 'Demo Driver', ?, ?)"
        ).run('driver1@example.com', driverPass, countryId, now);
        const driverUserId = driverUserResult.lastInsertRowid;
        console.log('   ✅ Driver user (id=' + driverUserId + ')');

        const driverResult = db.prepare(
            "INSERT OR IGNORE INTO drivers (user_id, country_id, agency_id, status, is_online, last_gps_lat, last_gps_lng, last_gps_at, approved_at, created_at) VALUES (?, ?, ?, 'approved', 0, 25.2854, 51.5310, ?, ?, ?)"
        ).run(driverUserId, countryId, agencyId, now, now, now);
        const driverId = driverResult.lastInsertRowid;
        console.log('   ✅ Driver profile (id=' + driverId + ')');

        // 4. Recovery vehicle
        const vehicleResult = db.prepare(
            "INSERT OR IGNORE INTO recovery_vehicles (country_id, agency_id, plate_number, vehicle_type, status, created_at) VALUES (?, ?, 'QA-TOW-1', 'flatbed', 'approved', ?)"
        ).run(countryId, agencyId, now);
        const vehicleId = vehicleResult.lastInsertRowid;
        console.log('   ✅ Recovery vehicle (id=' + vehicleId + ')');

        // 5. Driver ↔ vehicle link
        db.prepare("UPDATE drivers SET current_vehicle_id = ? WHERE id = ?").run(vehicleId, driverId);
        db.prepare("INSERT OR IGNORE INTO driver_vehicles (driver_id, recovery_vehicle_id, authorized_at) VALUES (?, ?, ?)")
          .run(driverId, vehicleId, now);
        console.log('   ✅ Driver-vehicle link');

        // 6. Driver license (CORRECTED: file_path, mime_type, size_bytes required)
        db.prepare(
            "INSERT OR IGNORE INTO driver_documents (driver_id, doc_type, file_path, mime_type, size_bytes, expires_at, review_status, uploaded_at) VALUES (?, 'driving_license', 'demo/license.pdf', 'application/pdf', 1024, '2030-12-31', 'approved', ?)"
        ).run(driverId, now);
        console.log('   ✅ Driver license');

        // 7. Enable services + set fares
        db.prepare(
            "UPDATE country_services SET is_enabled = 1, base_fare_minor = 2500, per_km_minor = 800, fast_surcharge_minor = 1500, min_fare_minor = 3000 WHERE country_id = ?"
        ).run(countryId);
        console.log('   ✅ Services enabled for Qatar');

        console.log('✅ Demo data seeded successfully!');
    } catch (e) {
        console.error('❌ Seed error:', e.message);
        console.error(e.stack);
    }
}

module.exports = { ensureDemoData };