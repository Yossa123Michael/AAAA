import type { Request, Response } from 'express';
import { pool } from '../db';

// GET /api/v1/commissions/summary?outletId=...
export const getCommissionSummary = async (req: Request, res: Response) => {
  try {
    const { outletId } = req.query;

    const query = `
      SELECT 
        b.id AS barber_id,
        b.nickname,
        b.level,
        COUNT(bc.id) FILTER (WHERE bc.status = 'APPROVED') AS pending_item_count,
        COALESCE(SUM(bc.commission_amount) FILTER (WHERE bc.status = 'APPROVED'), 0) AS pending_commission,
        COALESCE(SUM(bc.commission_amount) FILTER (WHERE bc.status = 'PAID_OUT'), 0) AS total_paid_commission
      FROM barbers b
      LEFT JOIN barber_commissions bc ON b.id = bc.barber_id
      WHERE b.outlet_id = $1
      GROUP BY b.id, b.nickname, b.level
      ORDER BY pending_commission DESC;
    `;

    const result = await pool.query(query, [outletId]);
    res.json({ success: true, data: result.rows });
  } catch (err: any) {
    res.status(500).json({ success: false, message: err.message });
  }
};

// GET /api/v1/commissions/details/:barberId?outletId=...
export const getBarberPendingDetails = async (req: Request, res: Response) => {
  try {
    const { barberId } = req.params;
    const { outletId } = req.query;

    const query = `
      SELECT 
        bc.id,
        bc.commission_amount,
        bc.rate_applied,
        bc.calculation_base,
        bc.created_at,
        t.invoice_number,
        COALESCE(s.name, p.name, 'Layanan / Produk') AS item_name
      FROM barber_commissions bc
      JOIN transactions t ON bc.transaction_id = t.id
      JOIN transaction_items ti ON bc.transaction_item_id = ti.id
      LEFT JOIN services s ON ti.service_id = s.id
      LEFT JOIN products p ON ti.product_id = p.id
      WHERE bc.barber_id = $1 AND bc.outlet_id = $2 AND bc.status = 'APPROVED'
      ORDER BY bc.created_at DESC;
    `;

    const result = await pool.query(query, [barberId, outletId]);
    res.json({ success: true, data: result.rows });
  } catch (err: any) {
    res.status(500).json({ success: false, message: err.message });
  }
};

// POST /api/v1/commissions/payout
export const payoutBarberCommission = async (req: Request, res: Response) => {
  const client = await pool.connect();
  try {
    const { outletId, barberId } = req.body;

    if (!outletId || !barberId) {
      return res.status(400).json({ success: false, message: 'outletId dan barberId wajib dikirim' });
    }

    await client.query('BEGIN');

    const updateRes = await client.query(
      `UPDATE barber_commissions 
       SET status = 'PAID_OUT'
       WHERE barber_id = $1 AND outlet_id = $2 AND status = 'APPROVED'
       RETURNING id, commission_amount`,
      [barberId, outletId]
    );

    if (updateRes.rowCount === 0) {
      throw new Error('Tidak ada komisi berstatus APPROVED yang dapat dicairkan.');
    }

    const totalPaid = updateRes.rows.reduce((sum, row) => sum + Number(row.commission_amount), 0);

    await client.query('COMMIT');

    res.json({
      success: true,
      message: `Komisi sebesar Rp ${totalPaid.toLocaleString('id-ID')} berhasil dicairkan!`,
      data: { totalPaid, itemCount: updateRes.rowCount }
    });
  } catch (err: any) {
    await client.query('ROLLBACK');
    res.status(400).json({ success: false, message: err.message });
  } finally {
    client.release();
  }
};