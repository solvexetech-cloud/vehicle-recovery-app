const express = require('express');
const router = express.Router();

let walletEnabled = true; 

router.get('/settings', (req, res) => {
    res.json({ wallet_enabled: walletEnabled });
});

router.post('/toggle', (req, res) => {
    try {
        if (req.body && typeof req.body.enabled !== 'undefined') {
            walletEnabled = req.body.enabled;
        }
        res.json({ success: true, wallet_enabled: walletEnabled });
    } catch(e) {
        res.status(500).json({ error: e.message });
    }
});

router.get('/driver/:driverId', (req, res) => {
    res.json({ wallet_enabled: walletEnabled, balance: 0, transactions: [] });
});

module.exports = router;
