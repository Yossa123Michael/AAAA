import type { Request, Response } from 'express';
import { pool } from '../db';
import { AvailabilityService } from '../services/availability';
import { sendBookingConfirmationWA } from '../services/whatsapp.service';

// Helper: Otomatis hanguskan pesanan PENDING_PAYMENT yang melewati batas 10 menit
export const cleanupExpiredBookings = async () => {
  try {
    await pool.query(`
      UPDATE bookings
      SET status = 'EXPIRED'
      WHERE status = 'PENDING_PAYMENT'
        AND expires_at IS NOT NULL
        AND expires_at <= NOW()
    `);
  } catch (err: any) {
    console.error('[CLEANUP_EXPIRED_BOOKINGS_ERROR]', err.message);
  }
};

// GET /api/v1/bookings/availability?barberId=...&date=YYYY-MM-DD&serviceId=...
export const getBarberAvailability = async (req: Request, res: Response) => {
  try {
    await cleanupExpiredBookings();

    const { barberId, date, serviceId, duration } = req.query;

    if (!barberId || !date) {
      return res.status(400).json({ success: false, message: 'Parameter barberId dan date wajib diisi' });
    }

    const bookingDate = new Date(`${date}T00:00:00`);
    const dayOfWeek = bookingDate.getDay();

    // 1. Cek Apakah Kapster Libur Rutin Mingguan
    const weeklyOffCheck = await pool.query(
      `SELECT id FROM barber_weekly_off WHERE barber_id = $1 AND day_of_week = $2`,
      [barberId, dayOfWeek]
    );

    if (weeklyOffCheck.rowCount && weeklyOffCheck.rowCount > 0) {
      return res.json({
        success: true,
        message: 'Kapster libur rutin pada hari ini',
        data: [],
      });
    }

    // 2. Cek Apakah Kapster Sedang Cuti / Izin pada Tanggal Ini
    const leaveCheck = await pool.query(
      `SELECT reason FROM barber_leaves WHERE barber_id = $1 AND leave_date = $2`,
      [barberId, date]
    );

    if (leaveCheck.rowCount && leaveCheck.rowCount > 0) {
      return res.json({
        success: true,
        message: `Kapster sedang cuti (${leaveCheck.rows[0].reason || 'Izin'})`,
        data: [],
      });
    }

    // 3. Ambil Durasi Layanan & Buffer
    let duration_minutes = Number(duration) || 45;
    let buffer_minutes = 0;

    if (serviceId) {
      const serviceRes = await pool.query(
        'SELECT duration_minutes, buffer_minutes FROM services WHERE id = $1',
        [serviceId]
      );
      if (serviceRes.rowCount && serviceRes.rowCount > 0) {
        duration_minutes = serviceRes.rows[0].duration_minutes || duration_minutes;
        buffer_minutes = serviceRes.rows[0].buffer_minutes || 0;
      }
    }

    // 4. Ambil Jam Kerja Standar Barber
    const scheduleRes = await pool.query(
      `SELECT start_time, end_time, break_start, break_end, is_day_off
       FROM barber_schedules
       WHERE barber_id = $1 AND day_of_week = $2`,
      [barberId, dayOfWeek]
    );

    const schedule = scheduleRes.rows[0] || {
      start_time: '09:00:00',
      end_time: '21:00:00',
      break_start: null,
      break_end: null,
      is_day_off: false,
    };

    if (schedule.is_day_off) {
      return res.json({
        success: true,
        data: [],
      });
    }

    // 5. Ambil Booking yang Mengunci Slot (CONFIRMED/PAID/COMPLETED atau PENDING_PAYMENT yang belum lewat 10 menit)
    const existingBookingsRes = await pool.query(
      `SELECT start_time, end_time
       FROM bookings
       WHERE barber_id = $1
         AND booking_date = $2
         AND (
           UPPER(status) IN ('CONFIRMED', 'PAID', 'COMPLETED')
           OR (UPPER(status) = 'PENDING_PAYMENT' AND expires_at > NOW())
         )`,
      [barberId, date]
    );

    // 6. Kalkulasi Slot Jam Menggunakan AvailabilityService
    const slots = AvailabilityService.generateSlots({
      workStart: schedule.start_time,
      workEnd: schedule.end_time,
      breakStart: schedule.break_start,
      breakEnd: schedule.break_end,
      existingBookings: existingBookingsRes.rows.map((b: any) => ({
        startTime: b.start_time.slice(0, 5),
        endTime: b.end_time.slice(0, 5),
      })),
      durationMinutes: duration_minutes,
      bufferMinutes: buffer_minutes,
    });

    return res.json({
      success: true,
      data: slots,
    });
  } catch (error: any) {
    return res.status(500).json({ success: false, message: error.message });
  }
};

// POST /api/v1/bookings (Reservasi Baru dengan Hold Slot 10 Menit)
export const createBooking = async (req: Request, res: Response) => {
  const client = await pool.connect();
  try {
    await cleanupExpiredBookings();

    const {
      outletId = '22222222-2222-2222-2222-222222222222',
      customerId: loggedInCustomerId,
      customerName,
      customerPhone,
      barberId,
      serviceId,
      date,
      bookingDate,
      startTime,
      haircutNotes,
      notes,
    } = req.body;

    if (!loggedInCustomerId) {
      return res.status(401).json({
        success: false,
        message: 'Silakan login atau buat akun terlebih dahulu untuk melakukan pemesanan.',
      });
    }

    const targetDate = date || bookingDate;
    const finalNotes = haircutNotes || notes || null;

    if (!outletId || !barberId || !serviceId || !targetDate || !startTime) {
      return res.status(400).json({ success: false, message: 'Data reservasi belum lengkap' });
    }

    const bookingDateObj = new Date(`${targetDate}T00:00:00`);
    const dayOfWeek = bookingDateObj.getDay();

    const offCheck = await client.query(
      `SELECT 1 FROM barber_weekly_off WHERE barber_id = $1 AND day_of_week = $2
       UNION ALL
       SELECT 1 FROM barber_leaves WHERE barber_id = $1 AND leave_date = $3`,
      [barberId, dayOfWeek, targetDate]
    );

    if (offCheck.rowCount && offCheck.rowCount > 0) {
      return res.status(400).json({
        success: false,
        message: 'Kapster sedang tidak bertugas atau libur pada tanggal yang dipilih.',
      });
    }

    await client.query('BEGIN');

    // Bersihkan lagi di dalam transaksi untuk akurasi penuh
    await client.query(`
      UPDATE bookings
      SET status = 'EXPIRED'
      WHERE status = 'PENDING_PAYMENT'
        AND expires_at IS NOT NULL
        AND expires_at <= NOW()
    `);

    // 1. Pastikan Data Customer Tersinkronisasi & Gabungkan Jika Ada Duplikat Nama/No HP
    let customerId = loggedInCustomerId;
    const cleanPhone = (customerPhone || '').trim();
    const cleanName = (customerName || 'Pelanggan Online').trim();

    const dupCheck = await client.query(
      `SELECT id, phone, haircut_notes,
              COALESCE(loyalty_points, 0) AS pts,
              COALESCE(total_visits, 0) AS visits,
              COALESCE(total_spend, 0) AS spend
       FROM customers
       WHERE id != $1
         AND (
           ($2 != '' AND phone = $2)
           OR LOWER(full_name) = LOWER($3)
         )`,
      [customerId, cleanPhone, cleanName]
    );

    if (dupCheck.rowCount && dupCheck.rowCount > 0) {
      for (const oldRow of dupCheck.rows) {
        await client.query('UPDATE bookings SET customer_id = $1 WHERE customer_id = $2', [customerId, oldRow.id]);
        await client.query('UPDATE transactions SET customer_id = $1 WHERE customer_id = $2', [customerId, oldRow.id]);
        await client.query(
          `UPDATE customers
           SET loyalty_points = COALESCE(loyalty_points, 0) + $1,
               total_visits = COALESCE(total_visits, 0) + $2,
               total_spend = COALESCE(total_spend, 0) + $3,
               haircut_notes = COALESCE($4, haircut_notes, $5)
           WHERE id = $6`,
          [oldRow.pts, oldRow.visits, oldRow.spend, finalNotes, oldRow.haircut_notes, customerId]
        );
        await client.query('DELETE FROM customers WHERE id = $1', [oldRow.id]);
      }
    }

    await client.query(
      `UPDATE customers
       SET full_name = $1,
           phone = COALESCE(NULLIF($2, ''), phone),
           haircut_notes = COALESCE(NULLIF($3, ''), haircut_notes)
       WHERE id = $4`,
      [cleanName, cleanPhone, finalNotes, customerId]
    );

    // 2. Ambil Informasi Layanan
    const srv = await client.query(
      'SELECT name, base_price, duration_minutes FROM services WHERE id = $1',
      [serviceId]
    );
    if (srv.rowCount === 0) throw new Error('Layanan tidak valid');
    const { name: serviceName, base_price, duration_minutes } = srv.rows[0];

    // 3. Kalkulasi Waktu Selesai (End Time)
    const [h, m] = startTime.split(':').map(Number);
    const endMinutes = h * 60 + m + Number(duration_minutes);
    const endTime = `${Math.floor(endMinutes / 60).toString().padStart(2, '0')}:${(endMinutes % 60).toString().padStart(2, '0')}:00`;

    // 4. Validasi Bentrok Jadwal (Termasuk yang sedang PENDING_PAYMENT < 10 menit) dengan Penguncian
    const conflict = await client.query(
      `SELECT id FROM bookings
       WHERE barber_id = $1
         AND booking_date = $2
         AND (
           UPPER(status) IN ('CONFIRMED', 'PAID', 'COMPLETED')
           OR (UPPER(status) = 'PENDING_PAYMENT' AND expires_at > NOW())
         )
         AND (start_time < $4 AND end_time > $3)
       FOR UPDATE`,
      [barberId, targetDate, startTime, endTime]
    );

    if (conflict.rowCount && conflict.rowCount > 0) {
      throw new Error('Slot jam ini sedang dipesan / dikunci oleh pelanggan lain. Silakan pilih jam lain.');
    }

    const bookingCode = `BRB-${Date.now().toString().slice(-6)}`;

    // 5. Simpan Booking dengan status PENDING_PAYMENT dan batas waktu 10 menit
    const bookingInsert = await client.query(
      `INSERT INTO bookings (
        outlet_id, booking_code, customer_id, barber_id,
        booking_date, start_time, end_time, status, payment_status, expires_at, notes
      ) VALUES (
        $1, $2, $3, $4, $5, $6, $7, 'PENDING_PAYMENT', 'UNPAID', NOW() + INTERVAL '10 minutes', $8
      ) RETURNING id, expires_at`,
      [outletId, bookingCode, customerId, barberId, targetDate, startTime, endTime, finalNotes]
    );

    const bookingId = bookingInsert.rows[0].id;
    const expiresAt = bookingInsert.rows[0].expires_at;

    await client.query(
      `INSERT INTO booking_items (booking_id, service_id, price, duration_minutes)
       VALUES ($1, $2, $3, $4)`,
      [bookingId, serviceId, base_price, duration_minutes]
    );

    await client.query('COMMIT');

    return res.status(201).json({
      success: true,
      message: 'Slot berhasil dikunci selama 10 menit. Silakan selesaikan pembayaran!',
      data: {
        bookingId,
        bookingCode,
        date: targetDate,
        startTime,
        endTime,
        price: Number(base_price),
        serviceName,
        expiresAt,
        status: 'PENDING_PAYMENT',
      },
    });
  } catch (error: any) {
    try {
      await client.query('ROLLBACK');
    } catch {}
    if (!res.headersSent) {
      return res.status(400).json({ success: false, message: error.message });
    }
  } finally {
    client.release();
  }
};

// Auto-ensure kolom tukar poin pada tabel bookings
pool.query(`
  ALTER TABLE bookings ADD COLUMN IF NOT EXISTS expires_at TIMESTAMP WITH TIME ZONE;
  ALTER TABLE bookings ADD COLUMN IF NOT EXISTS payment_status VARCHAR(30) DEFAULT 'UNPAID';
  ALTER TABLE bookings ADD COLUMN IF NOT EXISTS payment_method VARCHAR(50);
  ALTER TABLE bookings ADD COLUMN IF NOT EXISTS paid_at TIMESTAMP WITH TIME ZONE;
  ALTER TABLE bookings ADD COLUMN IF NOT EXISTS points_redeemed INT DEFAULT 0;
  ALTER TABLE bookings ADD COLUMN IF NOT EXISTS discount_amount NUMERIC(14,2) DEFAULT 0;
  ALTER TABLE bookings ADD COLUMN IF NOT EXISTS final_price NUMERIC(14,2) DEFAULT 0;
`).catch((err) => console.error('[BOOKING_SCHEMA_SYNC]', err.message));

// POST /api/v1/bookings/:id/pay (Konfirmasi Pembayaran dalam 10 Menit + Tukar Poin)
export const confirmBookingPayment = async (req: Request, res: Response) => {
  const client = await pool.connect();
  try {
    const { id } = req.params;
    const { paymentMethod = 'QRIS', pointsRedeemed = 0 } = req.body;

    await client.query('BEGIN');

    const checkRes = await client.query(
      `SELECT b.*,
              c.id AS cust_id,
              c.full_name AS customer_name,
              c.phone AS customer_phone,
              COALESCE(c.loyalty_points, 0) AS current_points,
              bar.nickname AS barber_name,
              s.name AS service_name,
              COALESCE(bi.price, s.base_price, 0) AS original_price
       FROM bookings b
       LEFT JOIN customers c ON b.customer_id = c.id
       LEFT JOIN barbers bar ON b.barber_id = bar.id
       LEFT JOIN booking_items bi ON bi.booking_id = b.id
       LEFT JOIN services s ON bi.service_id = s.id
       WHERE b.id::text = $1 OR b.booking_code = $1
       FOR UPDATE OF b`,
      [id]
    );

    if (checkRes.rowCount === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ success: false, message: 'Data reservasi tidak ditemukan' });
    }

    const booking = checkRes.rows[0];

    // Cek apakah sudah lewat 10 menit atau sudah EXPIRED
    const isExpired =
      booking.status === 'EXPIRED' ||
      (booking.expires_at && new Date(booking.expires_at).getTime() <= Date.now());

    if (isExpired) {
      await client.query(`UPDATE bookings SET status = 'EXPIRED' WHERE id = $1`, [booking.id]);
      await client.query('COMMIT');
      return res.status(400).json({
        success: false,
        message: 'Waktu pembayaran 10 menit telah habis! Pesanan hangus dan slot jam telah dibuka kembali untuk pelanggan lain.',
      });
    }

    // Validasi & Hitung Tukar Poin (1 Poin = Rp 1.000)
    const originalPrice = Number(booking.original_price || 0);
    const availablePoints = Number(booking.current_points || 0);
    const maxRedeemablePoints = Math.min(availablePoints, Math.floor(originalPrice / 1000));
    const requestedPoints = Math.max(0, Math.floor(Number(pointsRedeemed) || 0));

    if (requestedPoints > availablePoints) {
      await client.query('ROLLBACK');
      return res.status(400).json({
        success: false,
        message: `Poin Anda tidak mencukupi (Saldo saat ini: ${availablePoints} Pts).`,
      });
    }

    const appliedPoints = Math.min(requestedPoints, maxRedeemablePoints);
    const discountAmount = appliedPoints * 1000;
    const finalPrice = Math.max(0, originalPrice - discountAmount);
    let remainingPoints = availablePoints;

    // Potong saldo poin member jika menggunakan fitur tukar poin
    if (appliedPoints > 0 && booking.cust_id) {
      const custUpdate = await client.query(
        `UPDATE customers
         SET loyalty_points = GREATEST(0, COALESCE(loyalty_points, 0) - $1)
         WHERE id = $2
         RETURNING loyalty_points`,
        [appliedPoints, booking.cust_id]
      );
      remainingPoints = Number(custUpdate.rows[0]?.loyalty_points ?? availablePoints - appliedPoints);
    }

    await client.query(
      `UPDATE bookings
       SET status = 'CONFIRMED',
           payment_status = 'PAID',
           payment_method = $1,
           points_redeemed = $2,
           discount_amount = $3,
           final_price = $4,
           paid_at = NOW()
       WHERE id = $5`,
      [paymentMethod, appliedPoints, discountAmount, finalPrice, booking.id]
    );

    // Update harga di booking_items agar sinkron saat kasir Check-In
    await client.query(
      `UPDATE booking_items SET price = $1 WHERE booking_id = $2`,
      [finalPrice, booking.id]
    );

    await client.query('COMMIT');

    // Kirim konfirmasi WhatsApp secara sinkron (await) agar tidak diputus Vercel Serverless
    if (booking.customer_phone && !String(booking.customer_phone).startsWith('WA-')) {
      try {
        await sendBookingConfirmationWA({
          phone: booking.customer_phone,
          customerName: booking.customer_name || 'Pelanggan',
          bookingCode: booking.booking_code,
          serviceName: booking.service_name || 'Treatment',
          barberName: booking.barber_name || 'Kapster',
          bookingDate: String(booking.booking_date).slice(0, 10),
          startTime: String(booking.start_time).slice(0, 5),
          price: finalPrice,
        });
      } catch (waErr: any) {
        console.error('[WA_NOTIF_ERROR]', waErr.message);
      }
    }

    return res.json({
      success: true,
      message: 'Pembayaran berhasil dikonfirmasi! Jadwal Anda telah dikunci.',
      data: {
        bookingId: booking.id,
        bookingCode: booking.booking_code,
        status: 'CONFIRMED',
        paymentMethod,
        originalPrice,
        pointsRedeemed: appliedPoints,
        discountAmount,
        finalPrice,
        remainingPoints,
      },
    });
  } catch (err: any) {
    try {
      await client.query('ROLLBACK');
    } catch {}
    return res.status(500).json({ success: false, message: err.message });
  } finally {
    client.release();
  }
};

// POST /api/v1/bookings/:id/cancel (Batalkan / Hanguskan Pesanan & Buka Kembali Slot)
export const cancelOrExpireBooking = async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    await pool.query(
      `UPDATE bookings
       SET status = 'EXPIRED'
       WHERE id = $1 AND UPPER(status) = 'PENDING_PAYMENT'`,
      [id]
    );
    return res.json({
      success: true,
      message: 'Pesanan dibatalkan/hangus. Slot jam telah dibuka kembali untuk pelanggan lain.',
    });
  } catch (err: any) {
    return res.status(500).json({ success: false, message: err.message });
  }
};

// GET /api/v1/bookings/active?outletId=...
export const getActiveBookings = async (req: Request, res: Response) => {
  try {
    await cleanupExpiredBookings();

    const { outletId } = req.query;

    let query = `
      SELECT
        b.id,
        b.booking_code,
        b.customer_id,
        COALESCE(c.full_name, 'Pelanggan') AS customer_name,
        COALESCE(c.phone, '-') AS customer_phone,
        b.booking_date::text AS booking_date,
        b.start_time,
        b.end_time,
        b.status,
        b.payment_status,
        b.barber_id,
        b.notes,
        bi.service_id,
        COALESCE(s.name, 'Layanan') AS service_name,
        COALESCE(s.base_price, 0) AS base_price,
        COALESCE(s.default_commission_percent, 0) AS default_commission_percent,
        COALESCE(bar.nickname, 'Kapster') AS barber_name
      FROM bookings b
      LEFT JOIN customers c ON b.customer_id = c.id
      LEFT JOIN booking_items bi ON bi.booking_id = b.id
      LEFT JOIN services s ON bi.service_id = s.id
      LEFT JOIN barbers bar ON b.barber_id = bar.id
      WHERE UPPER(b.status) = 'CONFIRMED'
    `;

    const params: any[] = [];
    if (outletId) {
      params.push(outletId);
      query += ` AND b.outlet_id = $1`;
    }

    query += ` ORDER BY b.booking_date ASC, b.start_time ASC`;

    const result = await pool.query(query, params);
    return res.json({ success: true, data: result.rows });
  } catch (error: any) {
    console.error('[GET_ACTIVE_BOOKINGS_ERROR]', error);
    return res.status(500).json({ success: false, message: error.message });
  }
};