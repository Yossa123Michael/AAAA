import type { Request, Response } from 'express';
import { pool } from '../db';

// Auto-migration: Pastikan kolom cost_price tersedia di tabel products
pool.query('ALTER TABLE products ADD COLUMN IF NOT EXISTS cost_price NUMERIC(12, 2) DEFAULT 0;')
  .then(() => console.log('>>> [DB FIX] Kolom products.cost_price siap digunakan! 🚀'))
  .catch((err: any) => console.error('>>> [DB FIX ERROR]', err.message));

// GET /api/v1/dashboard/summary?outletId=...
export const getDashboardSummary = async (req: Request, res: Response) => {
  try {
    const { outletId = '22222222-2222-2222-2222-222222222222' } = req.query;

    if (!outletId) {
      return res.status(400).json({ success: false, message: 'Parameter outletId wajib diisi' });
    }

    // 1. Metrik Sales Transaksi (Mendukung status PAID dan COMPLETED)
    const salesMetricsRes = await pool.query(
      `SELECT 
        COUNT(id) AS total_transactions,
        COALESCE(SUM(grand_total), 0) AS total_revenue,
        COALESCE(SUM(discount_total), 0) AS total_discounts,
        COALESCE(AVG(grand_total), 0) AS average_ticket,
        COUNT(id) FILTER (
          WHERE (created_at AT TIME ZONE 'Asia/Makassar')::date = (CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Makassar')::date
        ) AS today_transactions,
        COALESCE(SUM(grand_total) FILTER (
          WHERE (created_at AT TIME ZONE 'Asia/Makassar')::date = (CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Makassar')::date
        ), 0) AS today_revenue
       FROM transactions
       WHERE outlet_id = $1 
         AND UPPER(status) IN ('PAID', 'COMPLETED')`,
      [outletId]
    );

    // 2. Estimasi HPP Produk Retail (COGS) dengan perlindungan query
    let totalCogs = 0;
    try {
      const cogsRes = await pool.query(
        `SELECT COALESCE(SUM(ti.quantity * COALESCE(p.cost_price, 0)), 0) AS total_cogs
         FROM transaction_items ti
         JOIN transactions t ON ti.transaction_id = t.id
         JOIN products p ON ti.product_id = p.id
         WHERE t.outlet_id = $1 
           AND UPPER(t.status) IN ('PAID', 'COMPLETED') 
           AND ti.item_type = 'PRODUCT'`,
        [outletId]
      );
      totalCogs = Number(cogsRes.rows[0]?.total_cogs || 0);
    } catch (cogsErr: any) {
      console.warn('[COGS_WARN] Mengabaikan COGS sementara:', cogsErr.message);
      totalCogs = 0;
    }

    // 3. Total Komisi Kapster (Mencakup PENDING, APPROVED, & PAID_OUT)
    const commRes = await pool.query(
      `SELECT COALESCE(SUM(commission_amount), 0) AS total_commissions
       FROM barber_commissions
       WHERE outlet_id = $1 AND UPPER(status) IN ('PENDING', 'APPROVED', 'PAID_OUT')`,
      [outletId]
    );

    // 4. Total Beban Operasional & Rincian per Kategori
    const expenseRes = await pool.query(
      `SELECT 
         category,
         COALESCE(SUM(amount), 0) AS total_amount,
         COUNT(id) AS item_count
       FROM operational_expenses
       WHERE outlet_id = $1
       GROUP BY category
       ORDER BY total_amount DESC`,
      [outletId]
    );

    // 5. Breakdown Penjualan: Layanan vs Produk
    const itemSplitRes = await pool.query(
      `SELECT 
        ti.item_type,
        COUNT(ti.id) AS items_sold,
        COALESCE(SUM(ti.line_total), 0) AS total_revenue
       FROM transaction_items ti
       JOIN transactions t ON ti.transaction_id = t.id
       WHERE t.outlet_id = $1 AND UPPER(t.status) IN ('PAID', 'COMPLETED')
       GROUP BY ti.item_type`,
      [outletId]
    );

    // 6. Distribusi Metode Pembayaran
    let paymentMethodsRows: any[] = [];
    try {
      const paymentMethodsRes = await pool.query(
        `SELECT 
          p.payment_method,
          COUNT(p.id) AS usage_count,
          COALESCE(SUM(p.amount), 0) AS total_amount
         FROM transaction_payments p
         JOIN transactions t ON p.transaction_id = t.id
         WHERE t.outlet_id = $1 AND UPPER(t.status) IN ('PAID', 'COMPLETED')
         GROUP BY p.payment_method`,
        [outletId]
      );
      paymentMethodsRows = paymentMethodsRes.rows;
    } catch {
      paymentMethodsRows = [];
    }

    // 7. Leaderboard & Performa Kapster
    let barberLeaderboardRows: any[] = [];
    try {
      const barberPerformanceRes = await pool.query(
        `SELECT 
          b.id AS barber_id,
          b.nickname,
          b.level,
          COUNT(DISTINCT t.id) AS total_served_customers,
          COALESCE(SUM(ti.line_total), 0) AS total_sales_generated,
          COALESCE(SUM(bc.commission_amount), 0) AS total_commission_earned
         FROM barbers b
         LEFT JOIN transaction_items ti ON b.id = ti.barber_id
         LEFT JOIN transactions t ON ti.transaction_id = t.id AND UPPER(t.status) IN ('PAID', 'COMPLETED')
         LEFT JOIN barber_commissions bc ON ti.id = bc.transaction_item_id
         WHERE b.outlet_id = $1 AND b.is_active = TRUE
         GROUP BY b.id, b.nickname, b.level
         ORDER BY total_sales_generated DESC`,
        [outletId]
      );
      barberLeaderboardRows = barberPerformanceRes.rows;
    } catch {
      barberLeaderboardRows = [];
    }

    // 8. Peringatan Stok Rendah (Low Stock Alert)
    let lowStockRows: any[] = [];
    try {
      const lowStockRes = await pool.query(
        `SELECT p.name, p.sku, s.stock_quantity, s.min_stock_alert
         FROM inventory_stocks s
         JOIN products p ON s.product_id = p.id
         WHERE s.outlet_id = $1 AND s.stock_quantity <= s.min_stock_alert`,
        [outletId]
      );
      lowStockRows = lowStockRes.rows;
    } catch {
      lowStockRows = [];
    }

    // 9. Log Audit Diskon Manual & Voucher (10 Transaksi Diskon Terakhir)
  let discountAuditRows: any[] = [];
  try {
    const discountAuditRes = await pool.query(
      `SELECT
        t.id,
        t.invoice_number,
        TO_CHAR(t.created_at AT TIME ZONE 'Asia/Makassar', 'DD Mon HH24:MI') AS trx_time,
        COALESCE(c.full_name, 'Pelanggan') AS customer_name,
        t.subtotal,
        t.discount_total,
        t.grand_total,
        COALESCE(v.code, '-') AS voucher_code,
        COALESCE(t.discount_reason, 'Potongan Poin / Promo') AS discount_reason
       FROM transactions t
       LEFT JOIN customers c ON t.customer_id = c.id
       LEFT JOIN vouchers v ON t.voucher_id = v.id
       WHERE t.outlet_id = $1
         AND UPPER(t.status) IN ('PAID', 'COMPLETED')
         AND COALESCE(t.discount_total, 0) > 0
       ORDER BY t.created_at DESC
       LIMIT 10`,
      [outletId]
    );
    discountAuditRows = discountAuditRes.rows;
  } catch {
    discountAuditRows = [];
  }

    
    // Kalkulasi Angka Finansial Utama
    const totalRevenue = Number(salesMetricsRes.rows[0]?.total_revenue || 0);
    const totalDiscounts = Number(salesMetricsRes.rows[0]?.total_discounts || 0);
    const totalTrx = Number(salesMetricsRes.rows[0]?.total_transactions || 0);
    const averageTicket = Math.round(Number(salesMetricsRes.rows[0]?.average_ticket || 0));
    const totalCommissions = Number(commRes.rows[0]?.total_commissions || 0);
    const totalExpenses = expenseRes.rows.reduce((sum, r) => sum + Number(r.total_amount), 0);

    // Laba Bersih Riil: Omzet - HPP - Komisi - Beban Operasional
    const netProfit = totalRevenue - totalCogs - totalCommissions - totalExpenses;

    res.json({
      success: true,
      data: {
        totalRevenue,
        totalDiscounts,
        discountAuditLogs: discountAuditRows,
        totalTrx,
        totalCommissions,
        totalCogs,
        totalExpenses,
        netProfit,
        expenseBreakdown: expenseRes.rows.map((r) => ({
          category: r.category,
          totalAmount: Number(r.total_amount),
          itemCount: Number(r.item_count),
        })),
        todaySummary: {
          totalTransactions: Number(salesMetricsRes.rows[0]?.today_transactions || totalTrx),
          grossRevenue: Number(salesMetricsRes.rows[0]?.today_revenue || totalRevenue),
          averageTicket,
          estimatedCogs: totalCogs,
          netProfit,
        },
        revenueBreakdown: itemSplitRes.rows,
        paymentDistribution: paymentMethodsRows,
        barberLeaderboard: barberLeaderboardRows,
        lowStockAlerts: lowStockRows,
      },
    });
  } catch (error: any) {
    console.error('[DASHBOARD_CONTROLLER_ERROR]', error);
    res.status(500).json({ success: false, message: error.message });
  }
};