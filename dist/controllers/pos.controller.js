"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.voidTransaction = exports.getRecentTransactions = exports.checkout = void 0;
const db_1 = require("../db");
const commission_1 = require("../services/commission");
// POST /api/v1/pos/checkout
const checkout = async (req, res) => {
    const client = await db_1.pool.connect();
    try {
        const { outletId, shiftId, customerId, bookingId, items, payment, pointsRedeemed = 0 } = req.body;
        // Mulai transaksi database ACID
        await client.query('BEGIN');
        // 1. Verifikasi Shift Kasir Masih Buka
        const shiftCheck = await client.query('SELECT id, status FROM cashier_shifts WHERE id = $1 AND status = $2', [shiftId, 'OPEN']);
        if (shiftCheck.rowCount === 0) {
            throw new Error('Shift kasir tidak aktif atau sudah ditutup');
        }
        // 2. Validasi & Hitung Potongan Poin CRM (1 Poin = Rp 1.000)
        let pointsDiscount = 0;
        const redeemCount = Number(pointsRedeemed) || 0;
        if (redeemCount > 0) {
            const custCheck = await client.query('SELECT loyalty_points FROM customers WHERE id = $1 FOR UPDATE', [customerId]);
            if (custCheck.rowCount === 0) {
                throw new Error('Data pelanggan tidak ditemukan');
            }
            const currentPoints = custCheck.rows[0].loyalty_points || 0;
            if (redeemCount > currentPoints) {
                throw new Error(`Poin tidak mencukupi. Saldo saat ini: ${currentPoints} Pts`);
            }
            pointsDiscount = redeemCount * 1000;
        }
        // 3. Hitung Total Tagihan
        let subtotal = 0;
        let itemDiscountTotal = 0;
        for (const item of items) {
            subtotal += Number(item.unitPrice) * Number(item.quantity);
            itemDiscountTotal += Number(item.discountAmount || 0);
        }
        const totalDiscount = itemDiscountTotal + pointsDiscount;
        const grandTotal = Math.max(0, subtotal - totalDiscount);
        if (Number(payment.amountPaid) < grandTotal) {
            throw new Error('Nominal bayar kurang dari total transaksi');
        }
        const invoiceNumber = `INV-${Date.now().toString().slice(-6)}`;
        // 4. Simpan Header Transaksi
        const trxRes = await client.query(`INSERT INTO transactions (
        tenant_id, outlet_id, shift_id, customer_id, invoice_number,
        subtotal, discount_total, grand_total, status, created_by
      ) VALUES (
        (SELECT tenant_id FROM outlets WHERE id = $1),
        $1, $2, $3, $4, $5, $6, $7, 'PAID',
        (SELECT cashier_user_id FROM cashier_shifts WHERE id = $2)
      ) RETURNING id`, [outletId, shiftId, customerId, invoiceNumber, subtotal, totalDiscount, grandTotal]);
        const transactionId = trxRes.rows[0].id;
        let totalCommissionAwarded = 0;
        // 5. Proses Item, Potong Stok, dan Hitung Komisi
        for (const item of items) {
            const lineTotal = (Number(item.unitPrice) * Number(item.quantity)) - Number(item.discountAmount || 0);
            const itemInsert = await client.query(`INSERT INTO transaction_items (
          transaction_id, item_type, service_id, product_id,
          barber_id, quantity, unit_price, discount_amount, line_total
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING id`, [
                transactionId,
                item.itemType,
                item.itemType === 'SERVICE' ? item.id : null,
                item.itemType === 'PRODUCT' ? item.id : null,
                item.barberId,
                item.quantity,
                item.unitPrice,
                item.discountAmount || 0,
                lineTotal
            ]);
            const transactionItemId = itemInsert.rows[0].id;
            // Jika produk retail: potong stok fisik
            if (item.itemType === 'PRODUCT') {
                const stockRes = await client.query(`UPDATE inventory_stocks
           SET stock_quantity = stock_quantity - $1, updated_at = NOW()
           WHERE outlet_id = $2 AND product_id = $3
           RETURNING stock_quantity`, [item.quantity, outletId, item.id]);
                if (stockRes.rowCount === 0) {
                    throw new Error(`Stok produk tidak ditemukan`);
                }
                // Catat mutasi inventaris
                await client.query(`INSERT INTO inventory_transactions (
            outlet_id, product_id, reference_type, reference_id,
            quantity_change, balance_after, unit_cost
          ) VALUES ($1, $2, 'POS_SALE', $3, $4, $5, 0)`, [outletId, item.id, transactionId, -item.quantity, stockRes.rows[0].stock_quantity]);
            }
            // Hitung Komisi Barber
            const commCalc = commission_1.CommissionService.calculateItem({
                itemType: item.itemType,
                grossPrice: Number(item.unitPrice) * Number(item.quantity),
                discountAmount: Number(item.discountAmount || 0),
                customRate: item.customCommissionRate,
            });
            totalCommissionAwarded += commCalc.commissionAmount;
            await client.query(`INSERT INTO barber_commissions (
          outlet_id, barber_id, transaction_id, transaction_item_id,
          calculation_base, rate_applied, commission_amount, status
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, 'APPROVED')`, [
                outletId, item.barberId, transactionId, transactionItemId,
                commCalc.calculationBase, commCalc.rateApplied, commCalc.commissionAmount
            ]);
        }
        // 6. Catat Pembayaran
        await client.query(`INSERT INTO transaction_payments (transaction_id, payment_method, amount, reference_number)
       VALUES ($1, $2, $3, $4)`, [transactionId, payment.method, grandTotal, payment.referenceNumber || null]);
        // 7. Mutasi Poin CRM Pelanggan (Kurangi poin ditukar + Tambah 1 poin tiap Rp 10.000 tagihan bersih)
        const pointsEarned = Math.floor(grandTotal / 10000);
        await client.query(`UPDATE customers
       SET total_visits = total_visits + 1,
           total_spend = total_spend + $1,
           last_visit_at = CURRENT_TIMESTAMP,
           loyalty_points = GREATEST(0, loyalty_points - $2) + $3
       WHERE id = $4`, [grandTotal, redeemCount, pointsEarned, customerId]);
        // 8. Selesaikan Booking jika transaksi berasal dari reservasi
        if (bookingId) {
            await client.query(`UPDATE bookings SET status = 'COMPLETED', updated_at = NOW() WHERE id = $1`, [bookingId]);
        }
        await client.query('COMMIT');
        res.status(201).json({
            success: true,
            message: 'Transaksi berhasil diselesaikan!',
            data: {
                invoiceNumber,
                subtotal,
                discountAmount: totalDiscount,
                pointsRedeemed: redeemCount,
                grandTotal,
                totalCommissionAwarded,
                pointsEarned,
                paymentMethod: payment.method,
            },
        });
    }
    catch (error) {
        await client.query('ROLLBACK');
        console.error('[Checkout Error]', error);
        res.status(400).json({ success: false, message: error.message });
    }
    finally {
        client.release();
    }
};
exports.checkout = checkout;
// GET /api/v1/pos/transactions?outletId=...
const getRecentTransactions = async (req, res) => {
    try {
        const { outletId } = req.query;
        const query = `
      SELECT
        t.id,
        t.invoice_number,
        t.grand_total,
        COALESCE(tp.payment_method, 'UNKNOWN') AS payment_method,
        t.status,
        t.created_at,
        c.full_name AS customer_name,
        COALESCE(SUM(bc.commission_amount), 0) AS total_commission
      FROM transactions t
      JOIN customers c ON t.customer_id = c.id
      LEFT JOIN transaction_payments tp ON t.id = tp.transaction_id
      LEFT JOIN barber_commissions bc ON t.id = bc.transaction_id
      WHERE t.outlet_id = $1
      GROUP BY t.id, t.invoice_number, t.grand_total, tp.payment_method, t.status, t.created_at, c.full_name
      ORDER BY t.created_at DESC
      LIMIT 20
    `;
        const result = await db_1.pool.query(query, [outletId]);
        res.json({ success: true, data: result.rows });
    }
    catch (err) {
        res.status(500).json({ success: false, message: err.message });
    }
};
exports.getRecentTransactions = getRecentTransactions;
// POST /api/v1/pos/transactions/:id/void
const voidTransaction = async (req, res) => {
    const client = await db_1.pool.connect();
    try {
        const { id } = req.params;
        const { reason } = req.body;
        await client.query('BEGIN');
        // 1. Cek transaksi & status
        const trxRes = await client.query('SELECT status, outlet_id FROM transactions WHERE id = $1 FOR UPDATE', [id]);
        if (trxRes.rowCount === 0)
            throw new Error('Transaksi tidak ditemukan');
        if (trxRes.rows[0].status === 'VOID')
            throw new Error('Transaksi ini sudah dibatalkan sebelumnya');
        // 2. Kembalikan stok fisik di tabel inventory_stocks
        const itemsRes = await client.query(`SELECT product_id, quantity FROM transaction_items WHERE transaction_id = $1 AND item_type = 'PRODUCT'`, [id]);
        for (const item of itemsRes.rows) {
            const updatedStock = await client.query(`UPDATE inventory_stocks
         SET stock_quantity = stock_quantity + $1, updated_at = NOW()
         WHERE product_id = $2 AND outlet_id = $3
         RETURNING stock_quantity`, [item.quantity, item.product_id, trxRes.rows[0].outlet_id]);
            // Catat mutasi pengembalian stok akibat pembatalan
            await client.query(`INSERT INTO inventory_transactions (
          outlet_id, product_id, reference_type, reference_id,
          quantity_change, balance_after, unit_cost
        ) VALUES ($1, $2, 'POS_VOID_RETURN', $3, $4, $5, 0)`, [trxRes.rows[0].outlet_id, item.product_id, id, item.quantity, updatedStock.rows[0].stock_quantity]);
        }
        // 3. Batalkan komisi kapster di tabel barber_commissions
        await client.query('DELETE FROM barber_commissions WHERE transaction_id = $1', [id]);
        // 4. Perbarui status transaksi menjadi VOID
        await client.query(`UPDATE transactions
       SET status = 'VOID', notes = COALESCE(notes, '') || ' [VOID: ' || $2 || ']'
       WHERE id = $1`, [id, reason || 'Dibatalkan oleh kasir']);
        await client.query('COMMIT');
        res.json({ success: true, message: 'Transaksi berhasil di-void dan stok dikembalikan.' });
    }
    catch (err) {
        await client.query('ROLLBACK');
        res.status(400).json({ success: false, message: err.message });
    }
    finally {
        client.release();
    }
};
exports.voidTransaction = voidTransaction;
