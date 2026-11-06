"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.login = void 0;
const db_1 = require("../db");
const login = async (req, res) => {
    try {
        const { email, password } = req.body;
        if (!email || !password) {
            return res.status(400).json({ success: false, message: 'Email dan password wajib diisi' });
        }
        const userRes = await db_1.pool.query(`SELECT 
        id, 
        tenant_id, 
        outlet_id, 
        COALESCE(name, full_name) AS name, 
        email, 
        COALESCE(role, 'CASHIER') AS role, 
        COALESCE(password, password_hash) AS password 
       FROM users 
       WHERE LOWER(TRIM(email)) = LOWER(TRIM($1))`, [email]);
        if (userRes.rowCount === 0) {
            return res.status(401).json({ success: false, message: 'Email atau password salah' });
        }
        const user = userRes.rows[0];
        if (user.password.trim() !== password.trim()) {
            return res.status(401).json({ success: false, message: 'Email atau password salah' });
        }
        res.json({
            success: true,
            message: 'Login berhasil!',
            data: {
                id: user.id,
                name: user.name,
                email: user.email,
                role: user.role,
                outletId: user.outlet_id,
                token: `mock-jwt-token-${user.id}-${Date.now()}`
            }
        });
    }
    catch (err) {
        res.status(500).json({ success: false, message: err.message });
    }
};
exports.login = login;
