import express from 'express';
import type { Request, Response } from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import { pool } from './db';
import './index';

// Controllers
import { checkout, getRecentTransactions, voidTransaction, validateVoucher, sendReceiptWhatsApp } from './controllers/pos.controller';
import { getBarberAvailability, createBooking, getActiveBookings, confirmBookingPayment, cancelOrExpireBooking } from './controllers/booking.controller';
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
  ALTER TABLE customers ALTER COLUMN tenant_id DROP NOT NULL;
  ALTER TABLE customers ADD COLUMN IF NOT EXISTS email VARCHAR(255);
  ALTER TABLE customers ADD COLUMN IF NOT EXISTS username VARCHAR(100);
  ALTER TABLE customers ADD COLUMN IF NOT EXISTS password VARCHAR(255);
  ALTER TABLE customers ADD COLUMN IF NOT EXISTS password_hash VARCHAR(255);
  ALTER TABLE customers ADD COLUMN IF NOT EXISTS google_id VARCHAR(255);
  ALTER TABLE customers ADD COLUMN IF NOT EXISTS provider_id VARCHAR(150);
  ALTER TABLE customers ADD COLUMN IF NOT EXISTS auth_provider VARCHAR(50) DEFAULT 'LOCAL';
  ALTER TABLE customers ADD COLUMN IF NOT EXISTS avatar_url TEXT;
`).catch((err) => console.error('Customer auth migration error:', err.message));

// 3B. Registrasi Akun Pelanggan Baru (Manual & Account Merging dengan Google Auth)
app.post('/api/v1/auth/customer/register', async (req: Request, res: Response) => {
  try {
    const { fullName, email, username, phone, password } = req.body;
    if (!fullName || !email || !password) {
      return res.status(400).json({
        success: false,
        message: 'Nama Lengkap, Email, dan Password wajib diisi!',
      });
    }

    const cleanEmail = String(email).trim().toLowerCase();
    const cleanPhone = phone && String(phone).trim() ? String(phone).trim() : null;
    const cleanUsername = username && String(username).trim() ? String(username).trim() : null;

    // 1. Cek apakah email sudah pernah terdaftar
    const existingEmail = await pool.query(
      `SELECT * FROM customers WHERE LOWER(email) = LOWER($1) LIMIT 1`,
      [cleanEmail]
    );

    let customer;
    if (existingEmail.rows.length > 0) {
      const existingCust = existingEmail.rows[0];

      if (existingCust.password_hash) {
        return res.status(400).json({
          success: false,
          message: 'Email ini sudah terdaftar, silakan langsung Login.',
        });
      }

      // Jika password_hash masih NULL (karena sebelumnya masuk lewat Google), satukan akunnya
      const updated = await pool.query(
        `UPDATE customers 
         SET full_name = $1,
             password_hash = $2,
             password = $2,
             phone = COALESCE($3, phone),
             username = COALESCE($4, username)
         WHERE id = $5 
         RETURNING *`,
        [fullName.trim(), password, cleanPhone, cleanUsername, existingCust.id]
      );
      customer = updated.rows[0];
    } else {
      if (cleanUsername) {
        const checkUsername = await pool.query(
          `SELECT id FROM customers WHERE LOWER(username) = LOWER($1) LIMIT 1`,
          [cleanUsername]
        );
        if (checkUsername.rows.length > 0) {
          return res.status(400).json({
            success: false,
            message: 'Username sudah digunakan!',
          });
        }
      }

      if (cleanPhone) {
        const existingPhone = await pool.query(
          `SELECT * FROM customers WHERE phone = $1 LIMIT 1`,
          [cleanPhone]
        );
        if (existingPhone.rows.length > 0) {
          const updated = await pool.query(
            `UPDATE customers 
             SET full_name = $1,
                 email = COALESCE($2, email),
                 username = COALESCE($3, username),
                 password_hash = $4,
                 password = $4
             WHERE id = $5 
             RETURNING *`,
            [fullName.trim(), cleanEmail, cleanUsername, password, existingPhone.rows[0].id]
          );
          customer = updated.rows[0];
        }
      }

      // Buat baris customer baru lengkap dengan tenant_id dari tabel outlets
      if (!customer) {
        const generatedOrCleanPhone =
          cleanPhone || `WA-${Math.floor(100000000 + Math.random() * 900000000)}`;
        const inserted = await pool.query(
          `INSERT INTO customers (
             tenant_id, full_name, phone, email, username, password_hash, password, loyalty_points, total_visits, total_spend
           ) VALUES (
             (SELECT tenant_id FROM outlets LIMIT 1), $1, $2, $3, $4, $5, $5, 0, 0, 0
           ) RETURNING *`,
          [fullName.trim(), generatedOrCleanPhone, cleanEmail, cleanUsername, password]
        );
        customer = inserted.rows[0];
      }
    }

    res.json({
      success: true,
      data: {
        id: customer.id,
        name: customer.full_name,
        email: customer.email,
        username: customer.username,
        phone: customer.phone?.startsWith('WA-') ? '' : (customer.phone || ''),
        loyalty_points: customer.loyalty_points || 0,
        haircut_notes: customer.haircut_notes || '',
        picture: customer.avatar_url || null,
        role: 'CUSTOMER',
      },
    });
  } catch (err: any) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// 3C. Login Pelanggan (Email, Username, atau Nomor HP)
app.post('/api/v1/auth/customer/login', async (req: Request, res: Response) => {
  try {
    const { identifier, email, password } = req.body;
    const loginId = (identifier || email || '').trim();

    if (!loginId || !password) {
      return res.status(400).json({
        success: false,
        message: 'Email/Username/No. HP dan Password wajib diisi!',
      });
    }

    const result = await pool.query(
      `SELECT * FROM customers 
       WHERE LOWER(email) = LOWER($1) OR LOWER(username) = LOWER($1) OR phone = $1
       LIMIT 1`,
      [loginId]
    );

    if (result.rows.length === 0) {
      return res.status(401).json({
        success: false,
        message: 'Email/Username/No. HP atau Password salah!',
      });
    }

    const c = result.rows[0];

    if (!c.password_hash && (!c.password || c.auth_provider === 'GOOGLE')) {
      return res.status(400).json({
        success: false,
        message:
          'Akun ini terdaftar melalui Google. Silakan klik tombol Continue with Google atau daftar untuk mengatur password.',
      });
    }

    const isPasswordMatch =
      (c.password_hash && c.password_hash === password) ||
      (!c.password_hash && c.password === password);

    if (!isPasswordMatch) {
      return res.status(401).json({
        success: false,
        message: 'Email/Username/No. HP atau Password salah!',
      });
    }

    res.json({
      success: true,
      data: {
        id: c.id,
        name: c.full_name,
        email: c.email,
        username: c.username,
        phone: c.phone?.startsWith('WA-') ? '' : (c.phone || ''),
        loyalty_points: c.loyalty_points || 0,
        haircut_notes: c.haircut_notes || '',
        picture: c.avatar_url || null,
        role: 'CUSTOMER',
      },
    });
  } catch (err: any) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// 3D. Login / Register Otomatis Pelanggan via Google OAuth2 API
app.post('/api/v1/auth/customer/google', async (req: Request, res: Response) => {
  try {
    const { accessToken, phone } = req.body;
    let { email, name, googleId, picture } = req.body;

    if (accessToken) {
      const googleRes = await fetch('https://www.googleapis.com/oauth2/v3/userinfo', {
        headers: { Authorization: `Bearer ${accessToken}` },
      });

      if (!googleRes.ok) {
        return res.status(401).json({
          success: false,
          message: 'Token Google OAuth2 tidak valid atau sudah kedaluwarsa.',
        });
      }

      const googleProfile: any = await googleRes.json();
      email = googleProfile.email;
      name = googleProfile.name;
      googleId = googleProfile.sub;
      picture = googleProfile.picture;
    }

    if (!email) {
      return res.status(400).json({ success: false, message: 'Email Google tidak valid' });
    }

    const cleanEmail = String(email).trim().toLowerCase();

    const existing = await pool.query(
      `SELECT * FROM customers 
       WHERE LOWER(email) = LOWER($1) 
          OR ($2::text IS NOT NULL AND (google_id = $2 OR provider_id = $2)) 
       LIMIT 1`,
      [cleanEmail, googleId || null]
    );

    let c;
    if (existing.rows.length > 0) {
      const updated = await pool.query(
        `UPDATE customers 
         SET google_id = COALESCE($1, google_id),
             provider_id = COALESCE($1, provider_id),
             email = COALESCE(email, $2),
             full_name = COALESCE(full_name, $3),
             avatar_url = COALESCE($4, avatar_url)
         WHERE id = $5 
         RETURNING *`,
        [
          googleId || null,
          cleanEmail,
          name || cleanEmail.split('@')[0],
          picture || null,
          existing.rows[0].id,
        ]
      );
      c = updated.rows[0];
    } else {
      const generatedPhone = phone || `WA-${Math.floor(100000000 + Math.random() * 900000000)}`;
      const inserted = await pool.query(
        `INSERT INTO customers (
           tenant_id, full_name, email, google_id, provider_id, auth_provider, avatar_url, phone, loyalty_points, total_visits, total_spend
         ) VALUES (
           (SELECT tenant_id FROM outlets LIMIT 1), $1, $2, $3, $3, 'GOOGLE', $4, $5, 0, 0, 0
         ) RETURNING *`,
        [
          name || cleanEmail.split('@')[0],
          cleanEmail,
          googleId || null,
          picture || null,
          generatedPhone,
        ]
      );
      c = inserted.rows[0];
    }

    res.json({
      success: true,
      data: {
        id: c.id,
        name: c.full_name,
        email: c.email,
        username: c.username,
        phone: c.phone?.startsWith('WA-') ? '' : (c.phone || ''),
        loyalty_points: c.loyalty_points || 0,
        haircut_notes: c.haircut_notes || '',
        picture: c.avatar_url || picture || null,
        role: 'CUSTOMER',
      },
    });
  } catch (err: any) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// 3E. Ambil Profil & Poin Terbaru Pelanggan (Real-time Sync)
app.get('/api/v1/auth/customer/profile', async (req: Request, res: Response) => {
  try {
    const { id } = req.query;
    if (!id) return res.status(400).json({ success: false, message: 'ID diperlukan' });

    const result = await pool.query('SELECT * FROM customers WHERE id = $1 LIMIT 1', [id]);
    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, message: 'Pelanggan tidak ditemukan' });
    }
    const c = result.rows[0];
    res.json({
      success: true,
      data: {
        id: c.id,
        name: c.full_name,
        email: c.email,
        username: c.username,
        phone: c.phone?.startsWith('WA-') ? '' : (c.phone || ''),
        loyalty_points: Number(c.loyalty_points || 0),
        haircut_notes: c.haircut_notes || '',
        picture: c.avatar_url || null,
        role: 'CUSTOMER',
      },
    });
  } catch (err: any) {
    res.status(500).json({ success: false, message: err.message });
  }
});

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
pool.query(`
  ALTER TABLE bookings ADD COLUMN IF NOT EXISTS expires_at TIMESTAMP WITH TIME ZONE;
  ALTER TABLE bookings ADD COLUMN IF NOT EXISTS payment_status VARCHAR(30) DEFAULT 'UNPAID';
  ALTER TABLE bookings ADD COLUMN IF NOT EXISTS payment_method VARCHAR(50);
  ALTER TABLE bookings ADD COLUMN IF NOT EXISTS paid_at TIMESTAMP WITH TIME ZONE;
  ALTER TABLE bookings DROP CONSTRAINT IF EXISTS bookings_status_check;
`).catch((e) => console.error('Booking alter error:', e.message));

// Endpoint Sinkronisasi & Auto-Merge Poin Member (Menggabungkan akun Google & POS seperti Yosself 38 Pts)
app.get('/api/v1/auth/customer/profile', async (req: Request, res: Response) => {
  try {
    const { id } = req.query;
    if (!id) return res.status(400).json({ success: false, message: 'ID diperlukan' });

    const mainRes = await pool.query('SELECT * FROM customers WHERE id = $1 LIMIT 1', [id]);
    if (mainRes.rows.length === 0) {
      return res.status(404).json({ success: false, message: 'Pelanggan tidak ditemukan' });
    }
    let c = mainRes.rows[0];

    // Cari apakah ada baris duplikat dengan nama yang sama (misal 'Yosself' di POS dengan 38 Pts)
    const dupRes = await pool.query(
      `SELECT * FROM customers
       WHERE id != $1
         AND (
           LOWER(TRIM(full_name)) = LOWER(TRIM($2))
           OR ($3::text IS NOT NULL AND $3 NOT LIKE 'WA-%' AND phone = $3)
         )`,
      [c.id, c.full_name || '', c.phone || null]
    );

    if (dupRes.rows.length > 0) {
      for (const dup of dupRes.rows) {
        await pool.query('UPDATE bookings SET customer_id = $1 WHERE customer_id = $2', [c.id, dup.id]);
        await pool.query('UPDATE transactions SET customer_id = $1 WHERE customer_id = $2', [c.id, dup.id]);
        const realPhone =
          c.phone && !String(c.phone).startsWith('WA-')
            ? c.phone
            : dup.phone && !String(dup.phone).startsWith('WA-')
            ? dup.phone
            : c.phone;

        const updated = await pool.query(
          `UPDATE customers
           SET loyalty_points = COALESCE(loyalty_points, 0) + COALESCE($1, 0),
               total_visits = COALESCE(total_visits, 0) + COALESCE($2, 0),
               total_spend = COALESCE(total_spend, 0) + COALESCE($3, 0),
               phone = $4,
               haircut_notes = COALESCE(haircut_notes, $5)
           WHERE id = $6
           RETURNING *`,
          [dup.loyalty_points, dup.total_visits, dup.total_spend, realPhone, dup.haircut_notes, c.id]
        );
        c = updated.rows[0];
        await pool.query('DELETE FROM customers WHERE id = $1', [dup.id]);
      }
    }

    res.json({
      success: true,
      data: {
        id: c.id,
        name: c.full_name,
        email: c.email,
        username: c.username,
        phone: c.phone?.startsWith('WA-') ? '' : (c.phone || ''),
        loyalty_points: Number(c.loyalty_points || 0),
        haircut_notes: c.haircut_notes || '',
        picture: c.avatar_url || null,
        role: 'CUSTOMER',
      },
    });
  } catch (err: any) {
    res.status(500).json({ success: false, message: err.message });
  }
});

app.post('/api/v1/bookings/:id/pay', confirmBookingPayment);
app.post('/api/v1/bookings/:id/cancel', cancelOrExpireBooking);

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
