import express from 'express';
import type { Request, Response } from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import { pool } from './db';
import './index';

// Controllers
import { checkout, getRecentTransactions, voidTransaction, validateVoucher, sendReceiptWhatsApp } from './controllers/pos.controller';
import { getBarberAvailability, createBooking, getActiveBookings } from './controllers/booking.controller';
import { closeShift, reopenShift } from './controllers/shift.controller';
import { getDashboardSummary } from './controllers/dashboard.controller';
import { getInventoryStocks, restockInventory } from './controllers/inventory.controller';
import { login, registerCustomer, socialLogin } from './controllers/auth.controller';
import { searchCustomers, createCustomer, updateHaircutNotes } from './controllers/customer.controller';
import { 
  getCommissionSummary, 
  getBarberPendingDetails, 
  payoutBarberCommission 
} from './controllers/commission.controller';
import { getExpenses, createExpense, deleteExpense } from './controllers/expense.controller';
import {
  getAllServices, createService, updateService,
  getAllProducts, createProduct, updateProduct,
  getAllBarbers, createBarber, updateBarber
} from './controllers/master.controller';
import { 
  exportSalesCSV, 
  exportExpensesCSV, 
  exportCommissionsCSV 
} from './controllers/report.controller';
import { getBarberPortalData } from './controllers/barber.controller';
import masterRoutes from './routes/master.routes';
import reportRoutes from './routes/reports.routes';
import rosterRoutes from './routes/roster.routes';

dotenv.config();

const app = express();
const PORT = Number(process.env.PORT) || 5000;

// Middleware
app.use(cors());
app.use(express.json());

// ==================== ROUTES ====================

// 1. Rute Status Server
app.get('/', (_req: Request, res: Response) => {
  res.json({ status: 'OK', message: 'Barbershop OS API is running 💈' });
});

// 2. Rute Test Katalog
app.get('/api/v1/test-catalog', async (_req: Request, res: Response) => {
  try {
    const services = await pool.query('SELECT id, code, name, base_price, default_commission_percent FROM services WHERE COALESCE(is_active, true) = true');
    const products = await pool.query('SELECT id, sku, name, selling_price, default_commission_percent FROM products WHERE COALESCE(is_active, true) = true');
    const barbers = await pool.query('SELECT id, nickname, level FROM barbers WHERE COALESCE(is_active, true) = true');

    res.json({
      success: true,
      data: {
        services: services.rows,
        products: products.rows,
        barbers: barbers.rows,
      },
    });
  } catch (error: any) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// 3. Autentikasi RBAC
app.post('/api/v1/auth/login', login);
// Auto-alter tabel customers untuk mendukung Akun Login & Google Auth
pool.query(`
  ALTER TABLE customers ADD COLUMN IF NOT EXISTS email VARCHAR(255);
  ALTER TABLE customers ADD COLUMN IF NOT EXISTS username VARCHAR(100);
  ALTER TABLE customers ADD COLUMN IF NOT EXISTS password_hash VARCHAR(255);
  ALTER TABLE customers ADD COLUMN IF NOT EXISTS google_id VARCHAR(255);
`).catch((err) => console.error('Customer auth migration error:', err.message));

// 3B. Registrasi Akun Pelanggan Baru (Manual)
app.post('/api/v1/auth/customer/register', async (req: Request, res: Response) => {
  try {
    const { fullName, email, username, phone, password } = req.body;
    if (!fullName || !phone || !password) {
      return res.status(400).json({ success: false, message: 'Nama, No. WhatsApp, dan Password wajib diisi!' });
    }

    // Cek apakah email atau username sudah dipakai pelanggan lain
    if (email || username) {
      const checkDup = await pool.query(
        `SELECT id FROM customers WHERE (email = $1 AND $1 IS NOT NULL AND $1 != '') OR (username = $2 AND $2 IS NOT NULL AND $2 != '')`,
        [email || null, username || null]
      );
      if (checkDup.rows.length > 0) {
        return res.status(400).json({ success: false, message: 'Email atau Username sudah digunakan!' });
      }
    }

    // Cek apakah nomor HP sudah terdaftar sebelumnya di kasir POS
    const existingPhone = await pool.query(`SELECT * FROM customers WHERE phone = $1 LIMIT 1`, [phone]);

    let customer;
    if (existingPhone.rows.length > 0) {
      const updated = await pool.query(
        `UPDATE customers 
         SET full_name = $1, email = COALESCE($2, email), username = COALESCE($3, username), password_hash = $4
         WHERE id = $5 RETURNING *`,
        [fullName, email || null, username || null, password, existingPhone.rows[0].id]
      );
      customer = updated.rows[0];
    } else {
      const inserted = await pool.query(
        `INSERT INTO customers (outlet_id, full_name, phone, email, username, password_hash, loyalty_points, total_visits, total_spend)
         VALUES ('22222222-2222-2222-2222-222222222222', $1, $2, $3, $4, $5, 0, 0, 0)
         RETURNING *`,
        [fullName, phone, email || null, username || null, password]
      );
      customer = inserted.rows[0];
    }

    res.json({
      success: true,
      data: {
        id: customer.id,
        name: customer.full_name,
        email: customer.email,
        username: customer.username,
        phone: customer.phone,
        loyalty_points: customer.loyalty_points || 0,
        haircut_notes: customer.haircut_notes || '',
        role: 'CUSTOMER',
      },
    });
  } catch (err: any) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// 3C. Login Pelanggan (Bisa pakai Email, Username, atau Nomor HP)
app.post('/api/v1/auth/customer/login', async (req: Request, res: Response) => {
  try {
    const { identifier, password } = req.body;
    const result = await pool.query(
      `SELECT * FROM customers 
       WHERE (LOWER(email) = LOWER($1) OR LOWER(username) = LOWER($1) OR phone = $1)
       AND password_hash = $2
       LIMIT 1`,
      [identifier, password]
    );

    if (result.rows.length === 0) {
      return res.status(401).json({ success: false, message: 'Email/Username/No. HP atau Password salah!' });
    }

    const c = result.rows[0];
    res.json({
      success: true,
      data: {
        id: c.id,
        name: c.full_name,
        email: c.email,
        username: c.username,
        phone: c.phone,
        loyalty_points: c.loyalty_points || 0,
        haircut_notes: c.haircut_notes || '',
        role: 'CUSTOMER',
      },
    });
  } catch (err: any) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// 3D. Login / Register Otomatis Pelanggan via Google API
app.post('/api/v1/auth/customer/google', async (req: Request, res: Response) => {
  try {
    const { email, name, googleId, phone } = req.body;
    if (!email) {
      return res.status(400).json({ success: false, message: 'Email Google tidak valid' });
    }

    const existing = await pool.query(
      `SELECT * FROM customers WHERE LOWER(email) = LOWER($1) OR google_id = $2 LIMIT 1`,
      [email, googleId]
    );

    let c;
    if (existing.rows.length > 0) {
      const updated = await pool.query(
        `UPDATE customers SET google_id = COALESCE($1, google_id), full_name = COALESCE(full_name, $2) WHERE id = $3 RETURNING *`,
        [googleId, name, existing.rows[0].id]
      );
      c = updated.rows[0];
    } else {
      const generatedPhone = phone || `WA-${Math.floor(100000000 + Math.random() * 900000000)}`;
      const inserted = await pool.query(
        `INSERT INTO customers (outlet_id, full_name, email, google_id, phone, loyalty_points, total_visits, total_spend)
         VALUES ('22222222-2222-2222-2222-222222222222', $1, $2, $3, $4, 0, 0, 0)
         RETURNING *`,
        [name || email.split('@')[0], email, googleId, generatedPhone]
      );
      c = inserted.rows[0];
    }

    res.json({
      success: true,
      data: {
        id: c.id,
        name: c.full_name,
        email: c.email,
        phone: c.phone?.startsWith('WA-') ? '' : c.phone,
        loyalty_points: c.loyalty_points || 0,
        haircut_notes: c.haircut_notes || '',
        role: 'CUSTOMER',
      },
    });
  } catch (err: any) {
    res.status(500).json({ success: false, message: err.message });
  }
});
app.post('/api/v1/auth/register-customer', registerCustomer);
app.post('/api/v1/auth/social-login', socialLogin);

// 4. POS Kasir & Transaksi
app.post('/api/v1/pos/checkout', checkout);
app.get('/api/v1/pos/transactions', getRecentTransactions);
app.post('/api/v1/pos/transactions/:id/void', voidTransaction);
app.post('/api/v1/pos/vouchers/validate', validateVoucher);
app.post('/api/v1/pos/send-receipt-wa', sendReceiptWhatsApp);

// 5. Booking & Antrean
app.get('/api/v1/bookings/availability', getBarberAvailability);
app.post('/api/v1/bookings', createBooking);
app.get('/api/v1/bookings/active', getActiveBookings);

// 6. Shift & Rekonsiliasi Kas
app.post('/api/v1/shifts/:shiftId/close', closeShift);
app.post('/api/v1/shifts/reopen', reopenShift);

// 7. Dashboard Analitik Owner
app.get('/api/v1/dashboard/summary', getDashboardSummary);

// 8. CRM Pelanggan & Barber Notes
app.get('/api/v1/customers/search', searchCustomers);
app.post('/api/v1/customers', createCustomer);
app.patch('/api/v1/customers/:id/notes', updateHaircutNotes);

// 9. Inventori & Restock Produk
app.get('/api/v1/inventory/stocks', getInventoryStocks);
app.post('/api/v1/inventory/restock', restockInventory);

// 10. Komisi Kapster (Payroll)
app.get('/api/v1/commissions/summary', getCommissionSummary);
app.get('/api/v1/commissions/details/:barberId', getBarberPendingDetails);
app.post('/api/v1/commissions/payout', payoutBarberCommission);

// 11. Biaya Operasional (Expense Tracker)
app.get('/api/v1/expenses', getExpenses);
app.post('/api/v1/expenses', createExpense);
app.delete('/api/v1/expenses/:id', deleteExpense);

// 12. Master Data Management (CRUD)
app.get('/api/v1/master/services', getAllServices);
app.post('/api/v1/master/services', createService);
app.put('/api/v1/master/services/:id', updateService);

app.get('/api/v1/master/products', getAllProducts);
app.post('/api/v1/master/products', createProduct);
app.put('/api/v1/master/products/:id', updateProduct);

app.get('/api/v1/master/barbers', getAllBarbers);
app.post('/api/v1/master/barbers', createBarber);
app.put('/api/v1/master/barbers/:id', updateBarber);

// 13. Ekspor Laporan Finansial (CSV)
app.get('/api/v1/reports/sales/csv', exportSalesCSV);
app.get('/api/v1/reports/expenses/csv', exportExpensesCSV);
app.get('/api/v1/reports/commissions/csv', exportCommissionsCSV);

// Tambahkan rute ini:
app.get('/api/v1/barbers/portal', getBarberPortalData);

app.use('/api/v1/master', masterRoutes);

// Daftarkan di bawah rute lainnya
app.use('/api/v1/reports', reportRoutes);

app.use('/api/v1/roster', rosterRoutes);

// ==================== 14. DATABASE VIEWS (BAHASA INDONESIA) & ADMIN TOOLS ====================
pool.query(`
  -- 1. View Katalog Layanan & Produk (Mudah dibaca di pgAdmin/DBeaver)
  CREATE OR REPLACE VIEW vw_katalog_toko AS
  SELECT 
    'LAYANAN CUKUR' AS kategori_item,
    code AS kode_item,
    name AS nama_item,
    0 AS harga_modal_rp,
    base_price AS harga_jual_rp,
    default_commission_percent AS komisi_kapster_persen,
    NULL::INT AS sisa_stok,
    CASE WHEN COALESCE(is_active, true) THEN 'AKTIF' ELSE 'NONAKTIF' END AS status_aktif
  FROM services
  UNION ALL
  SELECT 
    'PRODUK RETAIL' AS kategori_item,
    p.sku AS kode_item,
    p.name AS nama_item,
    COALESCE(p.cost_price, 0) AS harga_modal_rp,
    p.selling_price AS harga_jual_rp,
    p.default_commission_percent AS komisi_kapster_persen,
    COALESCE(s.stock_quantity, 0) AS sisa_stok,
    CASE WHEN COALESCE(p.is_active, true) THEN 'AKTIF' ELSE 'NONAKTIF' END AS status_aktif
  FROM products p
  LEFT JOIN inventory_stocks s ON p.id = s.product_id;

  -- 2. View Riwayat Transaksi Kasir Lengkap (Tanpa UUID)
  CREATE OR REPLACE VIEW vw_laporan_transaksi_kasir AS
  SELECT 
    t.invoice_number AS nomor_nota,
    TO_CHAR(t.created_at AT TIME ZONE 'Asia/Makassar', 'YYYY-MM-DD HH24:MI') AS waktu_transaksi,
    COALESCE(c.full_name, 'Pelanggan Umum') AS nama_pelanggan,
    COALESCE(c.phone, '-') AS nomor_wa,
    COALESCE(tp.payment_method, 'CASH') AS metode_bayar,
    t.subtotal AS subtotal_rp,
    COALESCE(t.discount_total, 0) AS total_diskon_rp,
    COALESCE(v.code, '-') AS kode_voucher,
    COALESCE(t.discount_reason, '-') AS alasan_diskon_audit,
    t.grand_total AS total_dibayar_rp,
    t.status AS status_pembayaran
  FROM transactions t
  LEFT JOIN customers c ON t.customer_id = c.id
  LEFT JOIN transaction_payments tp ON t.id = tp.transaction_id
  LEFT JOIN vouchers v ON t.voucher_id = v.id
  ORDER BY t.created_at DESC;

  -- 3. View Rekap Komisi Kapster
  CREATE OR REPLACE VIEW vw_rekap_komisi_kapster AS
  SELECT 
    TO_CHAR(bc.created_at AT TIME ZONE 'Asia/Makassar', 'YYYY-MM-DD HH24:MI') AS waktu,
    b.nickname AS nama_kapster,
    b.level AS level_kapster,
    t.invoice_number AS nomor_nota,
    COALESCE(s.name, p.name, 'Item') AS layanan_atau_produk,
    bc.calculation_base AS harga_dasar_rp,
    bc.rate_applied AS persentase_komisi,
    bc.commission_amount AS nominal_komisi_rp,
    bc.status AS status_pencairan
  FROM barber_commissions bc
  JOIN barbers b ON bc.barber_id = b.id
  JOIN transactions t ON bc.transaction_id = t.id
  JOIN transaction_items ti ON bc.transaction_item_id = ti.id
  LEFT JOIN services s ON ti.service_id = s.id
  LEFT JOIN products p ON ti.product_id = p.id
  ORDER BY bc.created_at DESC;

  -- 4. View Data Pelanggan & Poin Member
  CREATE OR REPLACE VIEW vw_data_pelanggan_crm AS
  SELECT 
    full_name AS nama_pelanggan,
    phone AS nomor_whatsapp,
    loyalty_points AS poin_member,
    total_visits AS jumlah_kunjungan,
    total_spend AS total_belanja_rp,
    COALESCE(haircut_notes, '-') AS catatan_model_rambut
  FROM customers
  ORDER BY total_visits DESC;
`)
  .then(() => console.log('>>> [DB VIEW] 4 Tabel Ringkasan Bahasa Indonesia SIAP! 🚀'))
  .catch((err) => console.error('>>> [DB VIEW ERROR]', err.message));

// Endpoint bagi Owner untuk melihat isi tabel ringkasan langsung dari Web
app.get('/api/v1/admin/db-overview', async (_req: Request, res: Response) => {
  try {
    const [katalog, transaksi, komisi, pelanggan] = await Promise.all([
      pool.query('SELECT * FROM vw_katalog_toko'),
      pool.query('SELECT * FROM vw_laporan_transaksi_kasir LIMIT 50'),
      pool.query('SELECT * FROM vw_rekap_komisi_kapster LIMIT 50'),
      pool.query('SELECT * FROM vw_data_pelanggan_crm LIMIT 50'),
    ]);
    res.json({
      success: true,
      data: {
        katalog: katalog.rows,
        transaksi: transaksi.rows,
        komisi: komisi.rows,
        pelanggan: pelanggan.rows,
      },
    });
  } catch (err: any) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// Endpoint bagi Owner untuk mereset data transaksi percobaan (Master Data tetap aman)
app.post('/api/v1/admin/reset-transactions', async (_req: Request, res: Response) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('DELETE FROM barber_commissions');
    await client.query('DELETE FROM transaction_payments');
    await client.query('DELETE FROM transaction_items');
    await client.query('DELETE FROM inventory_transactions');
    await client.query('DELETE FROM transactions');
    await client.query('DELETE FROM bookings');
    await client.query('DELETE FROM operational_expenses');
    await client.query('UPDATE vouchers SET used_count = 0');
    await client.query('UPDATE customers SET loyalty_points = 0, total_visits = 0, total_spend = 0');
    await client.query('COMMIT');

    res.json({
      success: true,
      message: 'Seluruh data transaksi uji coba berhasil dibersihkan! Master data (Layanan, Produk, Kapster, & Voucher) tetap tersimpan aman.',
    });
  } catch (err: any) {
    await client.query('ROLLBACK');
    res.status(500).json({ success: false, message: err.message });
  } finally {
    client.release();
  }
});

// ==================== LISTEN SERVER ====================
// Mendengarkan 0.0.0.0 agar bisa diakses dari HP pada jaringan Wi-Fi lokal
if (process.env.NODE_ENV !== 'production') {
  app.listen(PORT, '0.0.0.0', () => {
    console.log(`[SERVER] Aktif dan siap menerima koneksi di port ${PORT}`);
  });
}

export default app;
