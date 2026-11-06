import type { Request, Response } from 'express';
import { pool } from '../db';

// GET /api/v1/barbers/portal?barberId=...
export const getBarberPortalData = async (req: Request, res: Response) => {
  try {
    // Default fallback menggunakan ID Andi jika query kosong
    const { barberId = '44444444-4444-4444-4444-444444444444' } = req.query;

    // 1. Data Profil Kapster
    const barberRes = await pool.query(
      'SELECT id, nickname, level FROM barbers WHERE id = $1',
      [barberId]
    );
    const barberInfo = barberRes.rows[0] || { nickname: 'Kapster', level: 'BARBER' };

    // 2. Daftar Antrean Klien Khusus Kapster Ini Beserta Barber Notes
    const queueRes = await pool.query(
      `SELECT 
        b.id,
        b.booking_code,
        COALESCE(c.full_name, 'Pelanggan') AS customer_name,
        COALESCE(c.phone, '-') AS customer_phone,
        c.haircut_notes,
        b.booking_date::text AS booking_date,
        b.start_time,
        b.end_time,
        b.status,
        COALESCE(s.name, 'Layanan Treatment') AS service_name,
        COALESCE(s.duration_minutes, 45) AS duration_minutes
      FROM bookings b
      LEFT JOIN customers c ON b.customer_id = c.id
      LEFT JOIN booking_items bi ON bi.booking_id = b.id
      LEFT JOIN services s ON bi.service_id = s.id
      WHERE b.barber_id = $1 
        AND UPPER(b.status) IN ('CONFIRMED', 'PENDING')
      ORDER BY b.booking_date ASC, b.start_time ASC`,
      [barberId]
    );

    // 3. Ringkasan Finansial Pribadi (Khusus Hak Bagi Hasil Sendiri)
    const statsRes = await pool.query(
      `SELECT 
        COALESCE(SUM(commission_amount) FILTER (WHERE UPPER(status) = 'PENDING'), 0) AS pending_commission,
        COALESCE(SUM(commission_amount) FILTER (WHERE UPPER(status) = 'PAID_OUT'), 0) AS paid_commission,
        COALESCE(SUM(commission_amount), 0) AS total_commission,
        COUNT(id) AS total_services_completed
      FROM barber_commissions
      WHERE barber_id = $1`,
      [barberId]
    );

    // 4. Riwayat Komisi & Servis Terakhir
    const historyRes = await pool.query(
      `SELECT 
        bc.id,
        bc.commission_amount,
        bc.rate_applied,
        bc.status,
        bc.created_at,
        t.invoice_number,
        COALESCE(s.name, p.name, 'Treatment / Retail') AS item_name
      FROM barber_commissions bc
      LEFT JOIN transactions t ON bc.transaction_id = t.id
      LEFT JOIN transaction_items ti ON bc.transaction_item_id = ti.id
      LEFT JOIN services s ON ti.service_id = s.id
      LEFT JOIN products p ON ti.product_id = p.id
      WHERE bc.barber_id = $1
      ORDER BY bc.created_at DESC
      LIMIT 15`,
      [barberId]
    );

    res.json({
      success: true,
      data: {
        barber: barberInfo,
        stats: statsRes.rows[0] || {},
        queue: queueRes.rows,
        history: historyRes.rows,
      },
    });
  } catch (error: any) {
    console.error('[BARBER_PORTAL_ERROR]', error);
    res.status(500).json({ success: false, message: error.message });
  }
};