import type { Request, Response } from 'express';
import { pool } from '../db';

// POST /api/v1/shifts/:shiftId/close
export const closeShift = async (req: Request, res: Response) => {
  const client = await pool.connect();
  try {
    const { shiftId } = req.params;
    const { actualCash, varianceReason } = req.body;

    if (actualCash === undefined || actualCash === null) {
      return res.status(400).json({ success: false, message: 'Nominal uang fisik (actualCash) wajib diisi' });
    }

    await client.query('BEGIN');

    // 1. Ambil Data Shift & Modal Awal
    const shiftRes = await client.query(
      `SELECT id, opening_cash, status FROM cashier_shifts WHERE id = $1 FOR UPDATE`,
      [shiftId]
    );

    if (shiftRes.rowCount === 0) {
      throw new Error('Shift tidak ditemukan');
    }
    if (shiftRes.rows[0].status === 'CLOSED') {
      throw new Error('Shift ini sudah ditutup sebelumnya');
    }

    const openingCash = Number(shiftRes.rows[0].opening_cash);

    // 2. Hitung Total Penjualan Tunai (Cash) pada Shift Ini
    const cashSalesRes = await client.query(
      `SELECT COALESCE(SUM(p.amount), 0) AS total_cash_sales
       FROM transaction_payments p
       JOIN transactions t ON p.transaction_id = t.id
       WHERE t.shift_id = $1 AND p.payment_method = 'CASH' AND t.status = 'COMPLETED'`,
      [shiftId]
    );
    const cashSales = Number(cashSalesRes.rows[0].total_cash_sales);

    // 3. Hitung Pengeluaran Kas Operasional / Petty Cash pada Shift Ini
    const expensesRes = await client.query(
      `SELECT COALESCE(SUM(amount), 0) AS total_cash_expenses
       FROM expenses
       WHERE shift_id = $1 AND payment_method = 'CASH'`,
      [shiftId]
    );
    const cashExpenses = Number(expensesRes.rows[0].total_cash_expenses);

    // 4. Hitung Expected Cash & Selisih (Variance)
    const expectedCash = openingCash + cashSales - cashExpenses;
    const variance = Number(actualCash) - expectedCash;

    // Jika ada selisih uang, wajib sertakan alasan
    if (variance !== 0 && (!varianceReason || varianceReason.trim() === '')) {
      throw new Error(`Terdapat selisih kas sebesar Rp ${variance.toLocaleString('id-ID')}. Alasan selisih (varianceReason) wajib diisi.`);
    }

    // 5. Update Status Shift Menjadi CLOSED
    await client.query(
      `UPDATE cashier_shifts
       SET closed_at = NOW(),
           expected_cash = $1,
           actual_cash = $2,
           variance = $3,
           variance_reason = $4,
           status = 'CLOSED'
       WHERE id = $5`,
      [expectedCash, actualCash, variance, varianceReason || null, shiftId]
    );

    // 6. Rekapitulasi Pembayaran Non-Tunai & Komisi untuk Pelaporan
    const paymentBreakdown = await client.query(
      `SELECT p.payment_method, SUM(p.amount) AS total_amount, COUNT(DISTINCT t.id) AS total_trx
       FROM transaction_payments p
       JOIN transactions t ON p.transaction_id = t.id
       WHERE t.shift_id = $1 AND t.status = 'COMPLETED'
       GROUP BY p.payment_method`,
      [shiftId]
    );

    const commissionTotal = await client.query(
      `SELECT COALESCE(SUM(c.commission_amount), 0) AS total_commissions
       FROM barber_commissions c
       JOIN transactions t ON c.transaction_id = t.id
       WHERE t.shift_id = $1`,
      [shiftId]
    );

    await client.query('COMMIT');

    res.json({
      success: true,
      message: 'Shift kasir berhasil ditutup (Daily Closing selesai)',
      data: {
        shiftId,
        reconciliation: {
          openingCash,
          cashSales,
          cashExpenses,
          expectedCash,
          actualCash: Number(actualCash),
          variance,
          varianceReason: varianceReason || null,
        },
        financialSummary: {
          payments: paymentBreakdown.rows,
          totalBarberCommission: Number(commissionTotal.rows[0].total_commissions),
        },
      },
    });
  } catch (error: any) {
    await client.query('ROLLBACK');
    res.status(400).json({ success: false, message: error.message });
  } finally {
    client.release();
  }
};

// POST /api/v1/shifts/reopen
export const reopenShift = async (req: Request, res: Response) => {
  try {
    const { shiftId } = req.body;
    await pool.query(
      `UPDATE cashier_shifts 
       SET status = 'OPEN', closed_at = NULL, actual_cash = NULL, variance = NULL, variance_reason = NULL 
       WHERE id = $1`,
      [shiftId || 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa']
    );
    res.json({ success: true, message: 'Shift kasir berhasil dibuka kembali!' });
  } catch (err: any) {
    res.status(500).json({ success: false, message: err.message });
  }
};