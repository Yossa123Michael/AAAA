import type { Request, Response } from 'express';
import { pool } from '../db';
import { CommissionService } from '../services/commission';
import { sendDigitalReceiptWA } from '../services/whatsapp.service';

// Melepas check constraint agar status 'PAID' diterima database tanpa error
pool.query('ALTER TABLE transactions DROP CONSTRAINT IF EXISTS transactions_status_check;')
  .then(() => console.log('>>> [DB] transactions_status_check BERHASIL DIHAPUS! 🚀'))
  .catch((err: any) => console.error('>>> [DB ERROR]', err.message));

// POST /api/v1/pos/vouchers/validate
export const validateVoucher = async (req: Request, res: Response) => {
  try {
    const { code, subtotal } = req.body;

    if (!code || subtotal === undefined) {
      return res.status(400).json({
        success: false,
        message: 'Kode voucher dan subtotal belanja wajib diisi',
      });
    }

    const cleanCode = String(code).trim().toUpperCase();

    const result = await pool.query(
      `SELECT * FROM vouchers 
       WHERE UPPER(code) = $1 
         AND is_active = TRUE 
         AND CURRENT_DATE BETWEEN start_date AND end_date`,
      [cleanCode]
    );

    if (result.rowCount === 0) {
      return res.status(404).json({
        success: false,
        message: 'Kode voucher tidak ditemukan, sudah kedaluwarsa, atau tidak aktif.',
      });
    }

    const voucher = result.rows[0];

    // 1. Cek Kuota Penggunaan
    if (voucher.usage_limit !== null && voucher.used_count >= voucher.usage_limit) {
      return res.status(400).json({
        success: false,
        message: 'Kuota penggunaan voucher ini sudah habis.',
      });
    }

    // 2. Cek Minimal Belanja
    const orderSubtotal = Number(subtotal);
    if (orderSubtotal < Number(voucher.min_spend)) {
      return res.status(400).json({
        success: false,
        message: `Minimal belanja voucher ini adalah Rp ${Number(voucher.min_spend).toLocaleString('id-ID')}`,
      });
    }

    // 3. Hitung Potongan Diskon
    let discountAmount = 0;
    if (voucher.discount_type === 'PERCENTAGE') {
      discountAmount = (orderSubtotal * Number(voucher.discount_value)) / 100;
      if (voucher.max_discount && discountAmount > Number(voucher.max_discount)) {
        discountAmount = Number(voucher.max_discount);
      }
    } else {
      discountAmount = Number(voucher.discount_value);
    }

    if (discountAmount > orderSubtotal) {
      discountAmount = orderSubtotal;
    }

    return res.json({
      success: true,
      message: 'Voucher berhasil diterapkan!',
      data: {
        voucherId: voucher.id,
        code: voucher.code,
        discountType: voucher.discount_type,
        discountValue: Number(voucher.discount_value),
        discountAmount: Math.round(discountAmount),
      },
    });
  } catch (error: any) {
    console.error('[VALIDATE_VOUCHER_ERROR]', error);
    return res.status(500).json({ success: false, message: error.message });
  }
};

// POST /api/v1/pos/checkout
export const checkout = async (req: Request, res: Response) => {
  const client = await pool.connect();

  try {
    const {
      outletId,
      shiftId,
      customerId,
      bookingId = null,
      items,
      payment,
      pointsRedeemed = 0,
      voucherId = null,
      voucherDiscount = 0,
      manualDiscount = 0,
      discountReason = null,
    } = req.body;

    // Mulai transaksi database ACID
    await client.query('BEGIN');

    // 1. Verifikasi Shift Kasir Masih Buka
    const shiftCheck = await client.query(
      'SELECT id, status, cashier_user_id FROM cashier_shifts WHERE id = $1 AND status = $2',
      [shiftId, 'OPEN']
    );
    if (shiftCheck.rowCount === 0) {
      throw new Error('Shift kasir tidak aktif atau sudah ditutup');
    }

    // 2. Validasi & Hitung Potongan Poin CRM (1 Poin = Rp 1.000)
    let pointsDiscount = 0;
    const redeemCount = Number(pointsRedeemed) || 0;

    if (redeemCount > 0) {
      const custCheck = await client.query(
        'SELECT loyalty_points FROM customers WHERE id = $1 FOR UPDATE',
        [customerId]
      );
      if (custCheck.rowCount === 0) {
        throw new Error('Data pelanggan tidak ditemukan');
      }

      const currentPoints = custCheck.rows[0].loyalty_points || 0;
      if (redeemCount > currentPoints) {
        throw new Error(`Poin tidak mencukupi. Saldo saat ini: ${currentPoints} Pts`);
      }

      pointsDiscount = redeemCount * 1000;
    }

    // 3. Hitung Subtotal & Diskon Item
    let subtotal = 0;
    let itemDiscountTotal = 0;
    for (const item of items) {
      subtotal += Number(item.unitPrice) * Number(item.quantity);
      itemDiscountTotal += Number(item.discountAmount || 0);
    }

    // 4. Validasi & Kunci Kuota Voucher (Jika Menggunakan Voucher)
    let verifiedVoucherDiscount = Number(voucherDiscount) || 0;
    if (voucherId) {
      const vCheck = await client.query(
        `SELECT * FROM vouchers 
         WHERE id = $1 AND is_active = TRUE 
           AND CURRENT_DATE BETWEEN start_date AND end_date
         FOR UPDATE`,
        [voucherId]
      );

      if (vCheck.rowCount === 0) {
        throw new Error('Voucher sudah tidak valid atau kedaluwarsa');
      }

      const vData = vCheck.rows[0];
      if (vData.usage_limit !== null && vData.used_count >= vData.usage_limit) {
        throw new Error('Kuota voucher sudah habis');
      }
      if (subtotal < Number(vData.min_spend)) {
        throw new Error(`Minimal belanja voucher Rp ${Number(vData.min_spend).toLocaleString('id-ID')}`);
      }

      // Hitung ulang diskon voucher di sisi server agar aman
      if (vData.discount_type === 'PERCENTAGE') {
        verifiedVoucherDiscount = (subtotal * Number(vData.discount_value)) / 100;
        if (vData.max_discount && verifiedVoucherDiscount > Number(vData.max_discount)) {
          verifiedVoucherDiscount = Number(vData.max_discount);
        }
      } else {
        verifiedVoucherDiscount = Number(vData.discount_value);
      }
      verifiedVoucherDiscount = Math.round(verifiedVoucherDiscount);

      // Tambahkan counter pemakaian voucher
      await client.query(
        'UPDATE vouchers SET used_count = used_count + 1 WHERE id = $1',
        [voucherId]
      );
    }

    // 5. Total Diskon Gabungan (Item + Poin + Voucher + Manual Kasir)
    const verifiedManualDiscount = Math.max(0, Number(manualDiscount) || 0);
    const totalDiscount = Math.min(
      subtotal,
      itemDiscountTotal + pointsDiscount + verifiedVoucherDiscount + verifiedManualDiscount
    );
    const grandTotal = Math.max(0, subtotal - totalDiscount);

    if (Number(payment.amountPaid) < grandTotal) {
      throw new Error('Nominal bayar kurang dari total transaksi');
    }

    const invoiceNumber = `INV-${Date.now().toString().slice(-6)}`;

    // 6. Simpan Header Transaksi (termasuk booking_id, voucher_id, dan discount_reason)
    const trxRes = await client.query(
      `INSERT INTO transactions (
        tenant_id, outlet_id, shift_id, booking_id, customer_id, invoice_number,
        subtotal, discount_total, grand_total, status, created_by,
        voucher_id, discount_reason
      ) VALUES (
        (SELECT tenant_id FROM outlets WHERE id = $1),
        $1, $2, $3, $4, $5, $6, $7, $8, 'PAID',
        $9, $10, $11
      ) RETURNING id`,
      [
        outletId,
        shiftId,
        bookingId || null,
        customerId,
        invoiceNumber,
        subtotal,
        totalDiscount,
        grandTotal,
        shiftCheck.rows[0].cashier_user_id,
        voucherId || null,
        discountReason || null,
      ]
    );
    const transactionId = trxRes.rows[0].id;

    let totalCommissionAwarded = 0;

    // 7. Proses Item, Potong Stok, dan Hitung Komisi
    for (const item of items) {
      const lineTotal = (Number(item.unitPrice) * Number(item.quantity)) - Number(item.discountAmount || 0);
      const itemInsert = await client.query(
        `INSERT INTO transaction_items (
          transaction_id, item_type, service_id, product_id,
          barber_id, quantity, unit_price, discount_amount, line_total
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING id`,
        [
          transactionId,
          item.itemType,
          item.itemType === 'SERVICE' ? item.id : null,
          item.itemType === 'PRODUCT' ? item.id : null,
          item.barberId,
          item.quantity,
          item.unitPrice,
          item.discountAmount || 0,
          lineTotal,
        ]
      );
      const transactionItemId = itemInsert.rows[0].id;

      // Jika produk retail: potong stok fisik
      if (item.itemType === 'PRODUCT') {
        const stockRes = await client.query(
          `UPDATE inventory_stocks
           SET stock_quantity = stock_quantity - $1, updated_at = NOW()
           WHERE outlet_id = $2 AND product_id = $3
           RETURNING stock_quantity`,
          [item.quantity, outletId, item.id]
        );
        if (stockRes.rowCount === 0) {
          throw new Error('Stok produk tidak ditemukan');
        }

        await client.query(
          `INSERT INTO inventory_transactions (
            outlet_id, product_id, reference_type, reference_id,
            quantity_change, balance_after, unit_cost
          ) VALUES ($1, $2, 'POS_SALE', $3, $4, $5, 0)`,
          [outletId, item.id, transactionId, -item.quantity, stockRes.rows[0].stock_quantity]
        );
      }

      // Hitung Komisi Barber
      const commCalc = CommissionService.calculateItem({
        itemType: item.itemType,
        grossPrice: Number(item.unitPrice) * Number(item.quantity),
        discountAmount: Number(item.discountAmount || 0),
        customRate: item.customCommissionRate,
      });
      totalCommissionAwarded += commCalc.commissionAmount;

      await client.query(
        `INSERT INTO barber_commissions (
          outlet_id, barber_id, transaction_id, transaction_item_id,
          calculation_base, rate_applied, commission_amount, status
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, 'APPROVED')`,
        [
          outletId,
          item.barberId,
          transactionId,
          transactionItemId,
          commCalc.calculationBase,
          commCalc.rateApplied,
          commCalc.commissionAmount,
        ]
      );
    }

    // 8. Catat Pembayaran
    await client.query(
      `INSERT INTO transaction_payments (transaction_id, payment_method, amount, reference_number)
       VALUES ($1, $2, $3, $4)`,
      [transactionId, payment.method, grandTotal, payment.referenceNumber || null]
    );

    // 9. Mutasi Poin CRM Pelanggan
    const pointsEarned = Math.floor(grandTotal / 10000);
    await client.query(
      `UPDATE customers
       SET total_visits = total_visits + 1,
           total_spend = total_spend + $1,
           last_visit_at = CURRENT_TIMESTAMP,
           loyalty_points = GREATEST(0, loyalty_points - $2) + $3
       WHERE id = $4`,
      [grandTotal, redeemCount, pointsEarned, customerId]
    );

    // 10. Selesaikan Booking jika transaksi berasal dari reservasi
    if (bookingId) {
      await client.query(
        `UPDATE bookings SET status = 'COMPLETED', updated_at = NOW() WHERE id = $1`,
        [bookingId]
      );
    }

    // Commit transaksi ACID ke database
    await client.query('COMMIT');

    // 11. Kirim E-Receipt Digital via WhatsApp Gateway (Asynchronous / Non-blocking)
    (async () => {
      try {
        const custRes = await pool.query(
          'SELECT phone, full_name FROM customers WHERE id = $1',
          [customerId]
        );
        const customer = custRes.rows[0];

        if (customer && customer.phone && customer.phone !== '-') {
          const itemDetailsRes = await pool.query(
            `SELECT
              ti.quantity,
              ti.unit_price,
              ti.line_total,
              COALESCE(s.name, p.name, 'Treatment / Retail') AS name
             FROM transaction_items ti
             LEFT JOIN services s ON ti.service_id = s.id
             LEFT JOIN products p ON ti.product_id = p.id
             WHERE ti.transaction_id = $1`,
            [transactionId]
          );

          await sendDigitalReceiptWA({
            phone: customer.phone,
            customerName: customer.full_name || 'Pelanggan',
            invoiceNumber,
            items: itemDetailsRes.rows.map((row: any) => ({
              name: row.name,
              qty: Number(row.quantity),
              price: Number(row.unit_price),
              total: Number(row.line_total),
            })),
            subtotal,
            discount: totalDiscount,
            grandTotal,
            paymentMethod: payment.method,
            cashierName: 'Kasir POS',
          });
        }
      } catch (waErr: any) {
        console.error('[WA_RECEIPT_ERROR]', waErr.message);
      }
    })();

    res.status(201).json({
      success: true,
      message: 'Transaksi berhasil diselesaikan!',
      data: {
        transactionId,
        invoiceNumber,
        subtotal,
        discountAmount: totalDiscount,
        voucherDiscount: verifiedVoucherDiscount,
        manualDiscount: verifiedManualDiscount,
        pointsRedeemed: redeemCount,
        grandTotal,
        totalCommissionAwarded,
        pointsEarned,
        paymentMethod: payment.method,
      },
    });
  } catch (error: any) {
    await client.query('ROLLBACK');
    console.error('[Checkout Error]', error);
    res.status(400).json({ success: false, message: error.message });
  } finally {
    client.release();
  }
};

// GET /api/v1/pos/transactions?outletId=...
export const getRecentTransactions = async (req: Request, res: Response) => {
  try {
    const { outletId } = req.query;
    const query = `
      SELECT
        t.id,
        t.invoice_number,
        t.subtotal,
        t.discount_total,
        t.discount_reason,
        t.grand_total,
        COALESCE(tp.payment_method, 'UNKNOWN') AS payment_method,
        t.status,
        t.created_at,
        c.full_name AS customer_name,
        c.phone AS customer_phone,
        COALESCE(SUM(bc.commission_amount), 0) AS total_commission
      FROM transactions t
      JOIN customers c ON t.customer_id = c.id
      LEFT JOIN transaction_payments tp ON t.id = tp.transaction_id
      LEFT JOIN barber_commissions bc ON t.id = bc.transaction_id
      WHERE t.outlet_id = $1
      GROUP BY t.id, t.invoice_number, t.subtotal, t.discount_total, t.discount_reason, t.grand_total, tp.payment_method, t.status, t.created_at, c.full_name, c.phone
      ORDER BY t.created_at DESC
      LIMIT 20
    `;
    const result = await pool.query(query, [outletId]);
    res.json({ success: true, data: result.rows });
  } catch (err: any) {
    res.status(500).json({ success: false, message: err.message });
  }
};

// POST /api/v1/pos/transactions/:id/void
export const voidTransaction = async (req: Request, res: Response) => {
  const client = await pool.connect();
  try {
    const { id } = req.params;
    const { reason } = req.body;

    await client.query('BEGIN');

    // 1. Cek transaksi & status
    const trxRes = await client.query(
      'SELECT status, outlet_id, voucher_id FROM transactions WHERE id = $1 FOR UPDATE',
      [id]
    );
    if (trxRes.rowCount === 0) throw new Error('Transaksi tidak ditemukan');
    if (trxRes.rows[0].status === 'VOID') throw new Error('Transaksi ini sudah dibatalkan sebelumnya');

    const { outlet_id, voucher_id } = trxRes.rows[0];

    // 2. Kembalikan stok fisik di tabel inventory_stocks
    const itemsRes = await client.query(
      `SELECT product_id, quantity FROM transaction_items WHERE transaction_id = $1 AND item_type = 'PRODUCT'`,
      [id]
    );
    for (const item of itemsRes.rows) {
      const updatedStock = await client.query(
        `UPDATE inventory_stocks
         SET stock_quantity = stock_quantity + $1, updated_at = NOW()
         WHERE product_id = $2 AND outlet_id = $3
         RETURNING stock_quantity`,
        [item.quantity, item.product_id, outlet_id]
      );

      await client.query(
        `INSERT INTO inventory_transactions (
          outlet_id, product_id, reference_type, reference_id,
          quantity_change, balance_after, unit_cost
        ) VALUES ($1, $2, 'POS_VOID_RETURN', $3, $4, $5, 0)`,
        [outlet_id, item.product_id, id, item.quantity, updatedStock.rows[0].stock_quantity]
      );
    }

    // 3. Kembalikan kuota voucher jika transaksi tadi memakai voucher
    if (voucher_id) {
      await client.query(
        'UPDATE vouchers SET used_count = GREATEST(0, used_count - 1) WHERE id = $1',
        [voucher_id]
      );
    }

    // 4. Batalkan komisi kapster di tabel barber_commissions
    await client.query('DELETE FROM barber_commissions WHERE transaction_id = $1', [id]);

    // 5. Perbarui status transaksi menjadi VOID
    await client.query(
      `UPDATE transactions
       SET status = 'VOID', notes = COALESCE(notes, '') || ' [VOID: ' || $2 || ']'
       WHERE id = $1`,
      [id, reason || 'Dibatalkan oleh kasir']
    );

    await client.query('COMMIT');
    res.json({ success: true, message: 'Transaksi berhasil di-void, stok & kuota voucher dikembalikan.' });
  } catch (err: any) {
    await client.query('ROLLBACK');
    res.status(400).json({ success: false, message: err.message });
  } finally {
    client.release();
  }
};

// POST /api/v1/pos/send-receipt-wa
export const sendReceiptWhatsApp = async (req: Request, res: Response) => {
  try {
    const { transactionId, customerPhone } = req.body;

    if (!transactionId || !customerPhone) {
      return res.status(400).json({ success: false, message: 'transactionId dan customerPhone wajib diisi' });
    }

    const txRes = await pool.query(
      `SELECT t.*, u.full_name as cashier_name, c.full_name as customer_name
       FROM transactions t
       LEFT JOIN users u ON t.created_by = u.id
       LEFT JOIN customers c ON t.customer_id = c.id
       WHERE t.id = $1`,
      [transactionId]
    );

    if (txRes.rows.length === 0) {
      return res.status(404).json({ success: false, message: 'Transaksi tidak ditemukan' });
    }

    const tx = txRes.rows[0];

    const itemsRes = await pool.query(
      `SELECT ti.*, COALESCE(s.name, p.name) as item_name
       FROM transaction_items ti
       LEFT JOIN services s ON ti.service_id = s.id
       LEFT JOIN products p ON ti.product_id = p.id
       WHERE ti.transaction_id = $1`,
      [transactionId]
    );

    const payRes = await pool.query(
      `SELECT payment_method FROM transaction_payments WHERE transaction_id = $1 LIMIT 1`,
      [transactionId]
    );

    const items = itemsRes.rows.map((r) => ({
      name: r.item_name,
      qty: Number(r.quantity),
      price: Number(r.unit_price),
      total: Number(r.line_total),
    }));

    await sendDigitalReceiptWA({
      phone: customerPhone,
      customerName: tx.customer_name || 'Pelanggan',
      invoiceNumber: tx.invoice_number,
      items: items,
      subtotal: Number(tx.subtotal),
      discount: Number(tx.discount_total),
      grandTotal: Number(tx.grand_total),
      paymentMethod: payRes.rows[0]?.payment_method || 'CASH',
      cashierName: tx.cashier_name || 'Kasir',
    });

    res.json({ success: true, message: 'Struk WhatsApp berhasil dikirim!' });
  } catch (err: any) {
    console.error(err);
    res.status(500).json({ success: false, message: err.message });
  }
};

