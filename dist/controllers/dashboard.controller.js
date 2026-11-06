"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.getDashboardSummary = void 0;
const db_1 = require("../db");
// GET /api/v1/dashboard/summary?outletId=...
const getDashboardSummary = async (req, res) => {
    try {
        const { outletId = '22222222-2222-2222-2222-222222222222' } = req.query;
        if (!outletId) {
            return res.status(400).json({ success: false, message: 'Parameter outletId wajib diisi' });
        }
        // 1. Metrik Sales Transaksi (Mendukung status PAID dan COMPLETED)
        const salesMetricsRes = await db_1.pool.query(`SELECT 
        COUNT(id) AS total_transactions,
        COALESCE(SUM(grand_total), 0) AS total_revenue,
        COALESCE(AVG(grand_total), 0) AS average_ticket,
        COUNT(id) FILTER (
          WHERE (created_at AT TIME ZONE 'Asia/Makassar')::date = (CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Makassar')::date
        ) AS today_transactions,
        COALESCE(SUM(grand_total) FILTER (
          WHERE (created_at AT TIME ZONE 'Asia/Makassar')::date = (CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Makassar')::date
        ), 0) AS today_revenue
       FROM transactions
       WHERE outlet_id = $1 
         AND status IN ('PAID', 'COMPLETED')`, [outletId]);
        // 2. Estimasi HPP Produk Retail (COGS) dari transaction_items & master produk
        const cogsRes = await db_1.pool.query(`SELECT COALESCE(SUM(ti.quantity * COALESCE(p.cost_price, 0)), 0) AS total_cogs
       FROM transaction_items ti
       JOIN transactions t ON ti.transaction_id = t.id
       JOIN products p ON ti.product_id = p.id
       WHERE t.outlet_id = $1 
         AND t.status IN ('PAID', 'COMPLETED') 
         AND ti.item_type = 'PRODUCT'`, [outletId]);
        // 3. Total Komisi Kapster (Approved & Paid Out)
        const commRes = await db_1.pool.query(`SELECT COALESCE(SUM(commission_amount), 0) AS total_commissions
       FROM barber_commissions
       WHERE outlet_id = $1 AND status IN ('APPROVED', 'PAID_OUT')`, [outletId]);
        // 4. Total Beban Operasional & Rincian per Kategori
        const expenseRes = await db_1.pool.query(`SELECT 
         category,
         COALESCE(SUM(amount), 0) AS total_amount,
         COUNT(id) AS item_count
       FROM operational_expenses
       WHERE outlet_id = $1
       GROUP BY category
       ORDER BY total_amount DESC`, [outletId]);
        // 5. Breakdown Penjualan: Layanan vs Produk
        const itemSplitRes = await db_1.pool.query(`SELECT 
        ti.item_type,
        COUNT(ti.id) AS items_sold,
        COALESCE(SUM(ti.line_total), 0) AS total_revenue
       FROM transaction_items ti
       JOIN transactions t ON ti.transaction_id = t.id
       WHERE t.outlet_id = $1 AND t.status IN ('PAID', 'COMPLETED')
       GROUP BY ti.item_type`, [outletId]);
        // 6. Distribusi Metode Pembayaran
        const paymentMethodsRes = await db_1.pool.query(`SELECT 
        p.payment_method,
        COUNT(p.id) AS usage_count,
        COALESCE(SUM(p.amount), 0) AS total_amount
       FROM transaction_payments p
       JOIN transactions t ON p.transaction_id = t.id
       WHERE t.outlet_id = $1 AND t.status IN ('PAID', 'COMPLETED')
       GROUP BY p.payment_method`, [outletId]);
        // 7. Leaderboard & Performa Kapster
        const barberPerformanceRes = await db_1.pool.query(`SELECT 
        b.id AS barber_id,
        b.nickname,
        b.level,
        COUNT(DISTINCT t.id) AS total_served_customers,
        COALESCE(SUM(ti.line_total), 0) AS total_sales_generated,
        COALESCE(SUM(bc.commission_amount), 0) AS total_commission_earned
       FROM barbers b
       LEFT JOIN transaction_items ti ON b.id = ti.barber_id
       LEFT JOIN transactions t ON ti.transaction_id = t.id AND t.status IN ('PAID', 'COMPLETED')
       LEFT JOIN barber_commissions bc ON ti.id = bc.transaction_item_id
       WHERE b.outlet_id = $1 AND b.is_active = TRUE
       GROUP BY b.id, b.nickname, b.level
       ORDER BY total_sales_generated DESC`, [outletId]);
        // 8. Peringatan Stok Rendah (Low Stock Alert)
        const lowStockRes = await db_1.pool.query(`SELECT p.name, p.sku, s.stock_quantity, s.min_stock_alert
       FROM inventory_stocks s
       JOIN products p ON s.product_id = p.id
       WHERE s.outlet_id = $1 AND s.stock_quantity <= s.min_stock_alert`, [outletId]);
        // Kalkulasi Angka Finansial
        const totalRevenue = Number(salesMetricsRes.rows[0]?.total_revenue || 0);
        const totalTrx = Number(salesMetricsRes.rows[0]?.total_transactions || 0);
        const averageTicket = Math.round(Number(salesMetricsRes.rows[0]?.average_ticket || 0));
        const totalCogs = Number(cogsRes.rows[0]?.total_cogs || 0);
        const totalCommissions = Number(commRes.rows[0]?.total_commissions || 0);
        const totalExpenses = expenseRes.rows.reduce((sum, r) => sum + Number(r.total_amount), 0);
        // Rumus Laba Bersih Riil
        const netProfit = totalRevenue - totalCogs - totalCommissions - totalExpenses;
        res.json({
            success: true,
            data: {
                // Struktur data untuk 4 Kartu Ringkasan & Breakdown Dashboard
                totalRevenue,
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
                // Detail analitik komprehensif
                todaySummary: {
                    totalTransactions: Number(salesMetricsRes.rows[0]?.today_transactions || totalTrx),
                    grossRevenue: Number(salesMetricsRes.rows[0]?.today_revenue || totalRevenue),
                    averageTicket,
                    estimatedCogs: totalCogs,
                    netProfit,
                },
                revenueBreakdown: itemSplitRes.rows,
                paymentDistribution: paymentMethodsRes.rows,
                barberLeaderboard: barberPerformanceRes.rows,
                lowStockAlerts: lowStockRes.rows,
            },
        });
    }
    catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
};
exports.getDashboardSummary = getDashboardSummary;
