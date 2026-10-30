const express = require('express');
const router = express.Router();
const { DatabaseSync } = require('node:sqlite');
const path = require('path');

const dbPath = path.join(__dirname, '..', '..', 'data', 'app.db');
const db = new DatabaseSync(dbPath);

// Ensure Tables Exist
try {
    db.exec(`
        CREATE TABLE IF NOT EXISTS customer_vehicles (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            customer_id INTEGER DEFAULT 1,
            make TEXT, model TEXT, category TEXT, registration TEXT, color TEXT
        );
        CREATE TABLE IF NOT EXISTS customer_destinations (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            customer_id INTEGER DEFAULT 1,
            name TEXT, address TEXT
        );
    `);

    // Insert default vehicle if empty (so the UI isn't blank)
    const vCount = db.prepare("SELECT COUNT(*) as c FROM customer_vehicles").get().c;
    if (vCount === 0) {
        db.prepare("INSERT INTO customer_vehicles (customer_id, make, model, category, registration) VALUES (1, 'Toyota', 'Land Cruiser', 'SUV', 'QA-TEST1')").run();
    }
} catch(e) { console.error('Table setup error:', e.message); }

// --- VEHICLES ---
router.get('/vehicles', (req, res) => {
    try { res.json(db.prepare("SELECT * FROM customer_vehicles WHERE customer_id = 1").all()); } catch(e) { res.json([]); }
});

router.post('/vehicles', (req, res) => {
    try {
        const { make, model, category, registration, color } = req.body;
        db.prepare("INSERT INTO customer_vehicles (customer_id, make, model, category, registration, color) VALUES (1, ?, ?, ?, ?, ?)")
          .run(make, model, category, registration, color);
        res.json({ success: true });
    } catch(e) { res.status(500).json({ error: e.message }); }
});

router.delete('/vehicles/:id', (req, res) => {
    try { db.prepare("DELETE FROM customer_vehicles WHERE id = ?").run(req.params.id); res.json({ success: true }); } catch(e) { res.status(500).json({ error: e.message }); }
});

// --- DESTINATIONS ---
router.get('/destinations', (req, res) => {
    try { res.json(db.prepare("SELECT * FROM customer_destinations WHERE customer_id = 1").all()); } catch(e) { res.json([]); }
});

router.post('/destinations', (req, res) => {
    try {
        const { name, address } = req.body;
        db.prepare("INSERT INTO customer_destinations (customer_id, name, address) VALUES (1, ?, ?)")
          .run(name, address);
        res.json({ success: true });
    } catch(e) { res.status(500).json({ error: e.message }); }
});

router.delete('/destinations/:id', (req, res) => {
    try { db.prepare("DELETE FROM customer_destinations WHERE id = ?").run(req.params.id); res.json({ success: true }); } catch(e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
