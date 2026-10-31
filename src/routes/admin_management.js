const express = require('express');
const router = express.Router();
const { DatabaseSync } = require('node:sqlite');
const config = require('../config');

const db = new DatabaseSync(config.dbPath);

// --- GET ALL ---
router.get('/users', (req, res) => {
    try { res.json(db.prepare("SELECT * FROM users").all()); } catch(e) { res.json([]); }
});
router.get('/drivers', (req, res) => {
    try { res.json(db.prepare("SELECT * FROM drivers").all()); } catch(e) { res.json([]); }
});
router.get('/agencies', (req, res) => {
    try { res.json(db.prepare("SELECT * FROM agencies").all()); } catch(e) { res.json([]); }
});

// --- CREATE (ADD NEW) ---
router.post('/users', (req, res) => {
    try {
        const { name, email } = req.body || {};
        const cols = db.prepare("PRAGMA table_info(users)").all().map(c => c.name);
        const nameCol = cols.includes('full_name') ? 'full_name' : 'name';
        db.prepare(`INSERT INTO users (${nameCol}, email) VALUES (?, ?)`).run(name, email);
        res.json({ success: true });
    } catch(e) { res.status(500).json({error: e.message}); }
});

router.post('/drivers', (req, res) => {
    try {
        const { name, email } = req.body || {};
        db.prepare("INSERT INTO drivers (name, phone, status) VALUES (?, ?, 'Pending')").run(name, email);
        res.json({ success: true });
    } catch(e) { res.status(500).json({error: e.message}); }
});

router.post('/agencies', (req, res) => {
    try {
        const { name, email } = req.body || {};
        db.prepare("INSERT INTO agencies (name, email, status) VALUES (?, ?, 'Pending')").run(name, email);
        res.json({ success: true });
    } catch(e) { res.status(500).json({error: e.message}); }
});

// --- APPROVE DRIVER ---
router.put('/drivers/:id/approve', (req, res) => {
    try { db.prepare("UPDATE drivers SET status = 'Approved' WHERE id = ?").run(req.params.id); res.json({ success: true }); } catch(e) { res.status(500).json({error: e.message}); }
});

// --- DELETE ---
router.delete('/users/:id', (req, res) => {
    try { db.prepare("DELETE FROM users WHERE id = ?").run(req.params.id); res.json({ success: true }); } catch(e) { res.status(500).json({error: e.message}); }
});
router.delete('/drivers/:id', (req, res) => {
    try { db.prepare("DELETE FROM drivers WHERE id = ?").run(req.params.id); res.json({ success: true }); } catch(e) { res.status(500).json({error: e.message}); }
});
router.delete('/agencies/:id', (req, res) => {
    try { db.prepare("DELETE FROM agencies WHERE id = ?").run(req.params.id); res.json({ success: true }); } catch(e) { res.status(500).json({error: e.message}); }
});

module.exports = router;
