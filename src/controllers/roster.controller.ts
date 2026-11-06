import type { Request, Response } from 'express';
import { pool } from '../db';

// 1. Ambil jadwal libur rutin & cuti per kapster
export const getBarberRoster = async (req: Request, res: Response) => {
  try {
    const { barberId } = req.params;

    // Ambil hari libur mingguan (array integer day_of_week 0-6)
    const weeklyOffRes = await pool.query(
      `SELECT day_of_week FROM barber_weekly_off WHERE barber_id = $1 ORDER BY day_of_week ASC`,
      [barberId]
    );

    // Ambil cuti mendatang atau hari ini
    const leavesRes = await pool.query(
      `SELECT id, TO_CHAR(leave_date, 'YYYY-MM-DD') AS leave_date, reason 
       FROM barber_leaves 
       WHERE barber_id = $1 AND leave_date >= CURRENT_DATE 
       ORDER BY leave_date ASC`,
      [barberId]
    );

    res.json({
      success: true,
      data: {
        weeklyOff: weeklyOffRes.rows.map((r) => r.day_of_week),
        leaves: leavesRes.rows,
      },
    });
  } catch (err: any) {
    res.status(500).json({ success: false, message: err.message });
  }
};

// 2. Simpan hari libur rutin mingguan
export const updateWeeklyOff = async (req: Request, res: Response) => {
  const client = await pool.connect();
  try {
    const { barberId } = req.params;
    const { daysOff } = req.body; // Contoh: [1, 2] (Senin & Selasa)

    await client.query('BEGIN');
    await client.query(`DELETE FROM barber_weekly_off WHERE barber_id = $1`, [barberId]);

    if (Array.isArray(daysOff) && daysOff.length > 0) {
      for (const day of daysOff) {
        await client.query(
          `INSERT INTO barber_weekly_off (barber_id, day_of_week) VALUES ($1, $2)`,
          [barberId, day]
        );
      }
    }

    await client.query('COMMIT');
    res.json({ success: true, message: 'Hari libur rutin berhasil diperbarui' });
  } catch (err: any) {
    await client.query('ROLLBACK');
    res.status(500).json({ success: false, message: err.message });
  } finally {
    client.release();
  }
};

// 3. Tambah tanggal cuti khusus
export const addBarberLeave = async (req: Request, res: Response) => {
  try {
    const { barberId } = req.params;
    const { leaveDate, reason } = req.body;

    if (!leaveDate) {
      return res.status(400).json({ success: false, message: 'Tanggal cuti wajib dipilih' });
    }

    const result = await pool.query(
      `INSERT INTO barber_leaves (barber_id, leave_date, reason)
       VALUES ($1, $2, $3)
       ON CONFLICT (barber_id, leave_date) DO UPDATE SET reason = $3
       RETURNING id, TO_CHAR(leave_date, 'YYYY-MM-DD') AS leave_date, reason`,
      [barberId, leaveDate, reason || 'Cuti / Izin']
    );

    res.status(201).json({
      success: true,
      message: 'Jadwal cuti berhasil dicatat',
      data: result.rows[0],
    });
  } catch (err: any) {
    res.status(500).json({ success: false, message: err.message });
  }
};

// 4. Batalkan cuti
export const deleteBarberLeave = async (req: Request, res: Response) => {
  try {
    const { leaveId } = req.params;
    await pool.query(`DELETE FROM barber_leaves WHERE id = $1`, [leaveId]);
    res.json({ success: true, message: 'Jadwal cuti berhasil dibatalkan' });
  } catch (err: any) {
    res.status(500).json({ success: false, message: err.message });
  }
};

// 5. Cek ketersediaan kapster pada tanggal tertentu (Portal Booking / Kasir)
export const checkBarberAvailability = async (req: Request, res: Response) => {
  try {
    const { barberId, date } = req.query; // date format: YYYY-MM-DD
    if (!barberId || !date) {
      return res.status(400).json({ success: false, message: 'barberId dan date wajib disertakan' });
    }

    const targetDate = new Date(`${date}T00:00:00`);
    const dayOfWeek = targetDate.getDay(); // 0 = Minggu, 1 = Senin, ...

    // Cek libur mingguan
    const weeklyCheck = await pool.query(
      `SELECT id FROM barber_weekly_off WHERE barber_id = $1 AND day_of_week = $2`,
      [barberId, dayOfWeek]
    );

    if (weeklyCheck.rows.length > 0) {
      return res.json({
        success: true,
        isAvailable: false,
        reason: 'Kapster libur rutin pada hari ini',
      });
    }

    // Cek cuti tanggal spesifik
    const leaveCheck = await pool.query(
      `SELECT reason FROM barber_leaves WHERE barber_id = $1 AND leave_date = $2`,
      [barberId, date]
    );

    if (leaveCheck.rows.length > 0) {
      return res.json({
        success: true,
        isAvailable: false,
        reason: `Kapster sedang cuti (${leaveCheck.rows[0].reason || 'Izin'})`,
      });
    }

    return res.json({ success: true, isAvailable: true });
  } catch (err: any) {
    res.status(500).json({ success: false, message: err.message });
  }
};