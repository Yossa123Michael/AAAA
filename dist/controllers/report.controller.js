"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.exportCommissionsCSV = exports.exportExpensesCSV = exports.exportSalesCSV = void 0;
const db_1 = require("../db");
// Helper pembuat CSV dengan UTF-8 BOM agar rapi saat dibuka di Microsoft Excel
const sendCsvResponse = (res, filename, headers, rows) => {
    const BOM = '\uFEFF';
    const csvContent = [
        headers.join(','),
        ...rows.map(row => row.map(field => `"${String(field ?? '').replace(/"/g, '""')}"`).join(','))
    ].join('\r\n');
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.status(200).send(BOM + csvContent);
};
// GET /api/v1/reports/sales/csv?outletId=...
const exportSalesCSV = async (req, res) => {
    try {
        const { outletId = '22222222-2222-2222-2222-222222222222' } = req.query;
        const query = `
      SELECT 
        t.invoice_number,
        TO_CHAR(t.created_at AT TIME ZONE 'Asia/Makassar', 'YYYY-MM-DD HH24:MI:SS') AS transaction_time,
        c.full_name AS customer_name,
        c.phone AS customer_phone,
        COALESCE(tp.payment_method, 'CASH') AS payment_method,
        t.subtotal,
        t.discount_total,
        t.grand_total,
        t.status
      FROM transactions t
      JOIN customers c ON t.customer_id = c.id
      LEFT JOIN transaction_payments tp ON t.id = tp.transaction_id
      WHERE t.outlet_id = $1
      ORDER BY t.created_at DESC;
    `;
        const result = await db_1.pool.query(query, [outletId]);
        const headers = [
            'No Invoice',
            'Waktu Transaksi (WITA)',
            'Nama Pelanggan',
            'No Telepon',
            'Metode Bayar',
            'Subtotal (Rp)',
            'Diskon (Rp)',
            'Grand Total (Rp)',
            'Status Transaksi'
        ];
        const rows = result.rows.map(r => [
            r.invoice_number,
            r.transaction_time,
            r.customer_name,
            r.customer_phone,
            r.payment_method,
            r.subtotal,
            r.discount_total,
            r.grand_total,
            r.status
        ]);
        sendCsvResponse(res, `laporan-penjualan-${Date.now()}.csv`, headers, rows);
    }
    catch (err) {
        res.status(500).json({ success: false, message: err.message });
    }
};
exports.exportSalesCSV = exportSalesCSV;
// GET /api/v1/reports/expenses/csv?outletId=...
const exportExpensesCSV = async (req, res) => {
    try {
        const { outletId = '22222222-2222-2222-2222-222222222222' } = req.query;
        const query = `
      SELECT 
        TO_CHAR(created_at AT TIME ZONE 'Asia/Makassar', 'YYYY-MM-DD HH24:MI:SS') AS expense_time,
        category,
        amount,
        COALESCE(notes, '-') AS notes,
        COALESCE(created_by_name, 'Kasir') AS recorder
      FROM operational_expenses
      WHERE outlet_id = $1
      ORDER BY created_at DESC;
    `;
        const result = await db_1.pool.query(query, [outletId]);
        const headers = [
            'Waktu Input (WITA)',
            'Kategori Beban',
            'Nominal (Rp)',
            'Keterangan Rincian',
            'Dicatat Oleh'
        ];
        const rows = result.rows.map(r => [
            r.expense_time,
            r.category,
            r.amount,
            r.notes,
            r.recorder
        ]);
        sendCsvResponse(res, `laporan-pengeluaran-${Date.now()}.csv`, headers, rows);
    }
    catch (err) {
        res.status(500).json({ success: false, message: err.message });
    }
};
exports.exportExpensesCSV = exportExpensesCSV;
// GET /api/v1/reports/commissions/csv?outletId=...
const exportCommissionsCSV = async (req, res) => {
    try {
        const { outletId = '22222222-2222-2222-2222-222222222222' } = req.query;
        const query = `
      SELECT 
        TO_CHAR(bc.created_at AT TIME ZONE 'Asia/Makassar', 'YYYY-MM-DD HH24:MI:SS') AS commission_time,
        b.nickname AS barber_name,
        b.level AS barber_level,
        t.invoice_number,
        COALESCE(s.name, p.name, 'Layanan/Produk') AS item_name,
        bc.calculation_base,
        bc.rate_applied,
        bc.commission_amount,
        bc.status AS commission_status
      FROM barber_commissions bc
      JOIN barbers b ON bc.barber_id = b.id
      JOIN transactions t ON bc.transaction_id = t.id
      JOIN transaction_items ti ON bc.transaction_item_id = ti.id
      LEFT JOIN services s ON ti.service_id = s.id
      LEFT JOIN products p ON ti.product_id = p.id
      WHERE bc.outlet_id = $1
      ORDER BY bc.created_at DESC;
    `;
        const result = await db_1.pool.query(query, [outletId]);
        const headers = [
            'Waktu Transaksi (WITA)',
            'Nama Kapster',
            'Tingkat (Level)',
            'No Invoice',
            'Nama Item Layanan / Produk',
            'Dasar Perhitungan (Rp)',
            'Persentase Komisi (%)',
            'Nominal Komisi (Rp)',
            'Status Pencairan'
        ];
        const rows = result.rows.map(r => [
            r.commission_time,
            r.barber_name,
            r.barber_level,
            r.invoice_number,
            r.item_name,
            r.calculation_base,
            r.rate_applied,
            r.commission_amount,
            r.commission_status
        ]);
        sendCsvResponse(res, `laporan-komisi-kapster-${Date.now()}.csv`, headers, rows);
    }
    catch (err) {
        res.status(500).json({ success: false, message: err.message });
    }
};
exports.exportCommissionsCSV = exportCommissionsCSV;
