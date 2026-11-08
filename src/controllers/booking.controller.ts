import type { Request, Response } from 'express';
import { pool } from '../db';
import { AvailabilityService } from '../services/availability';
import { sendBookingConfirmationWA } from '../services/whatsapp.service';

// GET /api/v1/bookings/availability?barberId=...&date=YYYY-MM-DD&serviceId=...
export const getBarberAvailability = async (req: Request, res: Response) => {
  try {
    const { barberId, date, serviceId, duration } = req.query;

    if (!barberId || !date) {
      return res.status(400).json({ success: false, message: 'Parameter barberId dan date wajib diisi' });
    }

    const bookingDate = new Date(`${date}T00:00:00`);
    const dayOfWeek = bookingDate.getDay(); // 0 = Minggu, 1 = Senin, ...

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

    // Jika tidak ada jadwal default, gunakan jam operasional toko (09:00 - 21:00)
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

    // 5. Ambil Booking yang Masih Aktif pada Tanggal Tersebut
    const existingBookingsRes = await pool.query(
      `SELECT start_time, end_time 
       FROM bookings 
       WHERE barber_id = $1 AND booking_date = $2 AND status NOT IN ('CANCELLED', 'NO_SHOW')`,
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

// POST /api/v1/bookings (Reservasi Baru)
export const createBooking = async (req: Request, res: Response) => {
  const client = await pool.connect();
  try {
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
      notes
    } = req.body;

    const targetDate = date || bookingDate;
    const finalNotes = haircutNotes || notes || null;

    if (!outletId || !barberId || !serviceId || !targetDate || !startTime) {
      return res.status(400).json({ success: false, message: 'Data reservasi belum lengkap' });
    }

    // Validasi libur roster sebelum membuka transaksi
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

    // 1. Ambil atau Buat Data Customer (Prioritaskan Akun Member yang Sedang Login)
    let customerId: string = '';
    const cleanPhone = (customerPhone || '081299887766').trim();
    const cleanName = (customerName || 'Pelanggan Online').trim();

    if (loggedInCustomerId) {
      const checkMember = await client.query('SELECT id FROM customers WHERE id = $1', [loggedInCustomerId]);
      if (checkMember.rowCount && checkMember.rowCount > 0) {
        customerId = loggedInCustomerId;

        // Jika nomor WA yang diketik tadinya dipakai oleh data lama (misal 'yanto'), satukan poinnya ke akun Yosself
        const phoneConflict = await client.query(
          'SELECT id, COALESCE(loyalty_points, 0) AS pts, COALESCE(total_visits, 0) AS visits, COALESCE(total_spend, 0) AS spend FROM customers WHERE phone = $1 AND id != $2',
          [cleanPhone, customerId]
        );

        if (phoneConflict.rowCount && phoneConflict.rowCount > 0) {
          for (const oldRow of phoneConflict.rows) {
            await client.query('UPDATE bookings SET customer_id = $1 WHERE customer_id = $2', [customerId, oldRow.id]);
            await client.query('UPDATE transactions SET customer_id = $1 WHERE customer_id = $2', [customerId, oldRow.id]);
            await client.query(
              `UPDATE customers 
               SET loyalty_points = COALESCE(loyalty_points, 0) + $1,
                   total_visits = COALESCE(total_visits, 0) + $2,
                   total_spend = COALESCE(total_spend, 0) + $3
               WHERE id = $4`,
              [oldRow.pts, oldRow.visits, oldRow.spend, customerId]
            );
            await client.query('DELETE FROM customers WHERE id = $1', [oldRow.id]);
          }
        }

        // Update nama, nomor WA, dan catatan cukur pada akun member yang login
        await client.query(
          `UPDATE customers 
           SET full_name = $1, phone = $2, haircut_notes = COALESCE($3, haircut_notes)
           WHERE id = $4`,
          [cleanName, cleanPhone, finalNotes, customerId]
        );
      }
    }

    if (!customerId) {
      const existingCust = await client.query('SELECT id FROM customers WHERE phone = $1 LIMIT 1', [cleanPhone]);
      if (existingCust.rowCount && existingCust.rowCount > 0) {
        customerId = existingCust.rows[0].id;
        await client.query(
          `UPDATE customers 
           SET full_name = $1, haircut_notes = COALESCE($2, haircut_notes)
           WHERE id = $3`,
          [cleanName, finalNotes, customerId]
        );
      } else {
        const newCust = await client.query(
          `INSERT INTO customers (tenant_id, phone, full_name, segment, loyalty_points, haircut_notes)
           VALUES ((SELECT tenant_id FROM outlets LIMIT 1), $1, $2, 'NEW', 0, $3)
           RETURNING id`,
          [cleanPhone, cleanName, finalNotes]
        );
        customerId = newCust.rows[0].id;
      }
    }

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

    // 4. Validasi Bentrok Jadwal (Slot Conflict)
    const conflict = await client.query(
      `SELECT id FROM bookings 
       WHERE barber_id = $1 AND booking_date = $2 
         AND status NOT IN ('CANCELLED', 'NO_SHOW')
         AND (start_time < $4 AND end_time > $3)`,
      [barberId, targetDate, startTime, endTime]
    );

    if (conflict.rowCount && conflict.rowCount > 0) {
      throw new Error('Slot jadwal sudah dipesan pelanggan lain. Silakan pilih jam lain.');
    }

    const bookingCode = `BRB-${Date.now().toString().slice(-6)}`;

    // 5. Simpan Data Booking & Booking Items
    const bookingInsert = await client.query(
      `INSERT INTO bookings (
        outlet_id, booking_code, customer_id, barber_id,
        booking_date, start_time, end_time, status, notes
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, 'CONFIRMED', $8) RETURNING id`,
      [outletId, bookingCode, customerId, barberId, targetDate, startTime, endTime, finalNotes]
    );

    await client.query(
      `INSERT INTO booking_items (booking_id, service_id, price, duration_minutes)
       VALUES ($1, $2, $3, $4)`,
      [bookingInsert.rows[0].id, serviceId, base_price, duration_minutes]
    );

    await client.query('COMMIT');

    // Ambil Nama Kapster untuk Notifikasi
    const barberRes = await pool.query('SELECT nickname FROM barbers WHERE id = $1', [barberId]);
    const barberNickname = barberRes.rows[0]?.nickname || 'Kapster';

    // 6. Kirim Respons Berhasil ke Frontend
    res.status(201).json({
      success: true,
      message: 'Booking berhasil dikonfirmasi!',
      data: { bookingCode, date: targetDate, startTime, endTime },
    });

    // 7. Kirim Notifikasi WhatsApp Otomatis (Asinkron / Non-Blocking)
    if (customerPhone) {
      sendBookingConfirmationWA({
        phone: customerPhone,
        customerName: customerName || 'Pelanggan',
        bookingCode,
        serviceName: serviceName || 'Treatment',
        barberName: barberNickname,
        bookingDate: targetDate,
        startTime: startTime,
        price: Number(base_price),
      }).catch((waErr) => console.error('[WA_NOTIF_ERROR]', waErr.message));
    }

    return;
  } catch (error: any) {
    try {
      await client.query('ROLLBACK');
    } catch {}

    console.error('[CREATE_BOOKING_ERROR]', error);

    if (!res.headersSent) {
      return res.status(400).json({ success: false, message: error.message });
    }
  } finally {
    client.release();
  }
};

// GET /api/v1/bookings/active?outletId=...
export const getActiveBookings = async (req: Request, res: Response) => {
  try {
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
      WHERE (b.status IS NULL OR UPPER(b.status) NOT IN ('COMPLETED', 'CANCELLED', 'VOID'))
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