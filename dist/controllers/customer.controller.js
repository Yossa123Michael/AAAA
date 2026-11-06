"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.updateHaircutNotes = exports.createCustomer = exports.searchCustomers = void 0;
const db_1 = require("../db");
// GET /api/v1/customers/search?q=...
const searchCustomers = async (req, res) => {
    try {
        const { q } = req.query;
        const searchTerm = `%${(q || '').trim()}%`;
        const result = await db_1.pool.query(`SELECT 
        id, 
        full_name, 
        phone, 
        COALESCE(loyalty_points, 0) AS loyalty_points, 
        COALESCE(total_visits, 0) AS total_visits, 
        haircut_notes, 
        last_visit_at
       FROM customers
       WHERE phone ILIKE $1 OR full_name ILIKE $1
       ORDER BY last_visit_at DESC NULLS LAST
       LIMIT 10`, [searchTerm]);
        res.json({ success: true, data: result.rows });
    }
    catch (err) {
        res.status(500).json({ success: false, message: err.message });
    }
};
exports.searchCustomers = searchCustomers;
// POST /api/v1/customers
const createCustomer = async (req, res) => {
    try {
        const { fullName, phone, haircutNotes } = req.body;
        if (!fullName || !phone) {
            return res.status(400).json({ success: false, message: 'Nama dan nomor telepon wajib diisi' });
        }
        const checkExist = await db_1.pool.query('SELECT id FROM customers WHERE phone = $1', [phone]);
        if (checkExist.rowCount && checkExist.rowCount > 0) {
            return res.status(400).json({ success: false, message: 'Nomor telepon sudah terdaftar' });
        }
        const result = await db_1.pool.query(`INSERT INTO customers (
        tenant_id, full_name, phone, haircut_notes, loyalty_points, total_visits, total_spend
      ) VALUES (
        (SELECT tenant_id FROM outlets LIMIT 1),
        $1, $2, $3, 0, 0, 0
      ) RETURNING id, full_name, phone, loyalty_points, haircut_notes`, [fullName, phone, haircutNotes || null]);
        res.status(201).json({ success: true, message: 'Pelanggan baru berhasil disimpan', data: result.rows[0] });
    }
    catch (err) {
        res.status(500).json({ success: false, message: err.message });
    }
};
exports.createCustomer = createCustomer;
// PATCH /api/v1/customers/:id/notes
const updateHaircutNotes = async (req, res) => {
    try {
        const { id } = req.params;
        const { haircutNotes } = req.body;
        const result = await db_1.pool.query(`UPDATE customers 
       SET haircut_notes = $1, updated_at = NOW() 
       WHERE id = $2 
       RETURNING id, haircut_notes`, [haircutNotes, id]);
        if (result.rowCount === 0) {
            return res.status(404).json({ success: false, message: 'Pelanggan tidak ditemukan' });
        }
        res.json({ success: true, message: 'Catatan gaya rambut berhasil diperbarui', data: result.rows[0] });
    }
    catch (err) {
        res.status(500).json({ success: false, message: err.message });
    }
};
exports.updateHaircutNotes = updateHaircutNotes;
