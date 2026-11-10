import type { Request, Response } from 'express';
import { pool } from '../db';
import { AvailabilityService } from '../services/availability';
import { sendBookingConfirmationWA } from '../services/whatsapp.service';

// Auto-upgrade skema tabel bookings untuk mendukung Multi-Layanan, Produk, Outlet, Voucher, & Poin
pool.query(`
  ALTER TABLE bookings ADD COLUMN IF NOT EXISTS expires_at TIMESTAMP WITH TIME ZONE;
  ALTER TABLE bookings ADD COLUMN IF NOT EXISTS payment_status VARCHAR(30) DEFAULT 'UNPAID';
  ALTER TABLE bookings ADD COLUMN IF NOT EXISTS payment_method VARCHAR(50);
  ALTER TABLE bookings ADD COLUMN IF NOT EXISTS paid_at TIMESTAMP WITH TIME ZONE;
  ALTER TABLE bookings ADD COLUMN IF NOT EXISTS points_redeemed INT DEFAULT 0;
  ALTER TABLE bookings ADD COLUMN IF NOT EXISTS voucher_code VARCHAR(50);
  ALTER TABLE bookings ADD COLUMN IF NOT EXISTS voucher_discount NUMERIC(14,2) DEFAULT 0;
  ALTER TABLE bookings ADD COLUMN IF NOT EXISTS discount_amount NUMERIC(14,2) DEFAULT 0;
  ALTER TABLE bookings ADD COLUMN IF NOT EXISTS subtotal_price NUMERIC(14,2) DEFAULT 0;
  ALTER TABLE bookings ADD COLUMN IF NOT EXISTS final_price NUMERIC(14,2) DEFAULT 0;
  ALTER TABLE bookings ADD COLUMN IF NOT EXISTS outlet_name VARCHAR(150) DEFAULT 'Cabang Utama';
  ALTER TABLE bookings ADD COLUMN IF NOT EXISTS items_summary TEXT;
  ALTER TABLE bookings DROP CONSTRAINT IF EXISTS bookings_status_check;
`).catch((err) => console.error('[BOOKING_SCHEMA_SYNC]', err.message));

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

// GET /api/v1/bookings/availability
export const getBarberAvailability = async (req: Request, res: Response) => {
  try {
    await cleanupExpiredBookings();

    const { barberId, date, serviceId, duration } = req.query;

    if (!barberId || !date) {
      return res.status(400).json({ success: false, message: 'Parameter barberId dan date wajib diisi' });
    }

    const bookingDate = new Date(`${date}T00:00:00`);
    const dayOfWeek = bookingDate.getDay();

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

    let duration_minutes = Number(duration) || 45;
    let buffer_minutes = 0;

    if (!duration && serviceId) {
      const serviceRes = await pool.query(
        'SELECT duration_minutes, buffer_minutes FROM services WHERE id = $1',
        [serviceId]
      );
      if (serviceRes.rowCount && serviceRes.rowCount > 0) {
        duration_minutes = serviceRes.rows[0].duration_minutes || duration_minutes;
        buffer_minutes = serviceRes.rows[0].buffer_minutes || 0;
      }
    }

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
      return res.json({ success: true, data: [] });
    }

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

    return res.json({ success: true, data: slots });
  } catch (error: any) {
    return res.status(500).json({ success: false, message: error.message });
  }
};

// POST /api/v1/bookings (Mendukung Multi-Layanan, Add-on Produk, & Pemilihan Cabang)
export const createBooking = async (req: Request, res: Response) => {
  const client = await pool.connect();
  try {
    await cleanupExpiredBookings();

    const {
      outletId = '22222222-2222-2222-2222-222222222222',
      outletName = 'Cabang Makassar (Jl. Penghibur No. 88)',
      customerId: loggedInCustomerId,
      customerName,
      customerPhone,
      barberId,
      serviceId,
      serviceIds,
      productItems = [],
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

    const targetServiceIds: string[] =
      Array.isArray(serviceIds) && serviceIds.length > 0
        ? serviceIds
        : serviceId
        ? [serviceId]
        : [];

    const targetDate = date || bookingDate;
    const finalNotes = haircutNotes || notes || null;

    if (!barberId || targetServiceIds.length === 0 || !targetDate || !startTime) {
      return res.status(400).json({
        success: false,
        message: 'Pilih minimal 1 layanan treatment, kapster, tanggal, dan jam kunjungan.',
      });
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

    await client.query(`
      UPDATE bookings
      SET status = 'EXPIRED'
      WHERE status = 'PENDING_PAYMENT'
        AND expires_at IS NOT NULL
        AND expires_at <= NOW()
    `);

    // 1. Sinkronisasi Data Customer
    const customerId = loggedInCustomerId;
    const cleanPhone = (customerPhone || '').trim();
    const cleanName = (customerName || 'Pelanggan Online').trim();

    await client.query(
      `UPDATE customers
       SET full_name = $1,
           phone = COALESCE(NULLIF($2, ''), phone),
           haircut_notes = COALESCE(NULLIF($3, ''), haircut_notes)
       WHERE id = $4`,
      [cleanName, cleanPhone, finalNotes, customerId]
    );

    // 2. Ambil Semua Layanan yang Dipilih
    const srvRes = await client.query(
      'SELECT id, name, base_price, duration_minutes FROM services WHERE id = ANY($1::uuid[])',
      [targetServiceIds]
    );
    if (srvRes.rowCount === 0) throw new Error('Layanan tidak valid');

    let totalServicePrice = 0;
    let totalDurationMinutes = 0;
    const serviceNames: string[] = [];

    for (const s of srvRes.rows) {
      totalServicePrice += Number(s.base_price || 0);
      totalDurationMinutes += Number(s.duration_minutes || 45);
      serviceNames.push(s.name);
    }

    // 3. Hitung Produk Ritel Tambahan (Jika Pelanggan Memesan Produk)
    let totalProductPrice = 0;
    const productSummaries: string[] = [];

    if (Array.isArray(productItems) && productItems.length > 0) {
      for (const pItem of productItems) {
        const qty = Math.max(0, Number(pItem.qty || pItem.quantity || 0));
        if (qty > 0 && pItem.id) {
          const pRes = await client.query(
            'SELECT name, selling_price FROM products WHERE id = $1',
            [pItem.id]
          );
          if (pRes.rows.length > 0) {
            const pPrice = Number(pRes.rows[0].selling_price || 0);
            totalProductPrice += pPrice * qty;
            productSummaries.push(`${pRes.rows[0].name} (${qty}x)`);
          }
        }
      }
    }

    const grandSubtotal = totalServicePrice + totalProductPrice;
    const combinedSummary = [
      ...serviceNames,
      ...(productSummaries.length > 0 ? [`+ Produk: ${productSummaries.join(', ')}`] : []),
    ].join(', ');

    // 4. Kalkulasi Waktu Selesai (End Time)
    const [h, m] = startTime.split(':').map(Number);
    const endMinutes = h * 60 + m + totalDurationMinutes;
    const endTime = `${Math.floor(endMinutes / 60).toString().padStart(2, '0')}:${(endMinutes % 60).toString().padStart(2, '0')}:00`;

    // 5. Validasi Bentrok Jadwal
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

    // Pastikan outletId valid di tabel outlets (gunakan fallback outlet pertama jika tidak ditemukan)
    const outletCheck = await client.query('SELECT id FROM outlets WHERE id = $1 LIMIT 1', [outletId]);
    let validOutletId = outletId;
    if (outletCheck.rowCount === 0) {
      const firstOutlet = await client.query('SELECT id FROM outlets LIMIT 1');
      if (firstOutlet.rows.length > 0) validOutletId = firstOutlet.rows[0].id;
    }

    const bookingCode = `BRB-${Date.now().toString().slice(-6)}`;

    // 6. Simpan Booking dengan status PENDING_PAYMENT (Hold 10 Menit)
    const bookingInsert = await client.query(
      `INSERT INTO bookings (
        outlet_id, outlet_name, booking_code, customer_id, barber_id,
        booking_date, start_time, end_time, status, payment_status,
        expires_at, notes, items_summary, subtotal_price, final_price
      ) VALUES (
        $1, $2, $3, $4, $5, $6, $7, $8, 'PENDING_PAYMENT', 'UNPAID',
        NOW() + INTERVAL '10 minutes', $9, $10, $11, $11
      ) RETURNING id, expires_at`,
      [
        validOutletId,
        outletName,
        bookingCode,
        customerId,
        barberId,
        targetDate,
        startTime,
        endTime,
        finalNotes,
        combinedSummary,
        grandSubtotal,
      ]
    );

    const bookingId = bookingInsert.rows[0].id;
    const expiresAt = bookingInsert.rows[0].expires_at;

    // Simpan setiap layanan ke booking_items
    for (const s of srvRes.rows) {
      await client.query(
        `INSERT INTO booking_items (booking_id, service_id, price, duration_minutes)
         VALUES ($1, $2, $3, $4)`,
        [bookingId, s.id, s.base_price, s.duration_minutes]
      );
    }

    await client.query('COMMIT');

    return res.status(201).json({
      success: true,
      message: 'Slot berhasil dikunci selama 10 menit. Silakan selesaikan pembayaran!',
      data: {
        bookingId,
        bookingCode,
        outletName,
        date: targetDate,
        startTime,
        endTime,
        price: grandSubtotal,
        serviceName: combinedSummary,
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

// POST /api/v1/bookings/:id/pay (Konfirmasi Pembayaran + Tukar Poin + Klaim Voucher)
export const confirmBookingPayment = async (req: Request, res: Response) => {
  const client = await pool.connect();
  try {
    const { id } = req.params;
    const { paymentMethod = 'QRIS', pointsRedeemed = 0, voucherCode = null } = req.body;

    await client.query('BEGIN');

    const checkRes = await client.query(
      `SELECT b.*,
              c.id AS cust_id,
              c.full_name AS customer_name,
              c.phone AS customer_phone,
              COALESCE(c.loyalty_points, 0) AS current_points,
              bar.nickname AS barber_name
       FROM bookings b
       LEFT JOIN customers c ON b.customer_id = c.id
       LEFT JOIN barbers bar ON b.barber_id = bar.id
       WHERE b.id::text = $1 OR b.booking_code = $1
       FOR UPDATE OF b`,
      [id]
    );

    if (checkRes.rowCount === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ success: false, message: 'Data reservasi tidak ditemukan' });
    }

    const booking = checkRes.rows[0];

    const isExpired =
      booking.status === 'EXPIRED' ||
      (booking.expires_at && new Date(booking.expires_at).getTime() <= Date.now());

    if (isExpired) {
      await client.query(`UPDATE bookings SET status = 'EXPIRED' WHERE id = $1`, [booking.id]);
      await client.query('COMMIT');
      return res.status(400).json({
        success: false,
        message: 'Waktu pembayaran 10 menit telah habis! Pesanan hangus dan slot jam telah dibuka kembali.',
      });
    }

    // Hitung harga dasar booking
    const itemsSumRes = await client.query(
      'SELECT COALESCE(SUM(price), 0) AS srv_total FROM booking_items WHERE booking_id = $1',
      [booking.id]
    );
    const originalPrice = Number(
      booking.subtotal_price || booking.final_price || itemsSumRes.rows[0]?.srv_total || 0
    );

    // 1. Validasi & Hitung Diskon Voucher (Jika Diisi)
    let verifiedVoucherDiscount = 0;
    let appliedVoucherCode: string | null = null;

    if (voucherCode && String(voucherCode).trim() !== '') {
      const cleanCode = String(voucherCode).trim().toUpperCase();
      const vCheck = await client.query(
        `SELECT * FROM vouchers
         WHERE UPPER(code) = $1 AND is_active = TRUE
           AND CURRENT_DATE BETWEEN start_date AND end_date
         FOR UPDATE`,
        [cleanCode]
      );

      if (vCheck.rowCount && vCheck.rowCount > 0) {
        const vData = vCheck.rows[0];
        const quotaOk = vData.usage_limit === null || vData.used_count < vData.usage_limit;
        const minSpendOk = originalPrice >= Number(vData.min_spend || 0);

        if (quotaOk && minSpendOk) {
          if (vData.discount_type === 'PERCENTAGE') {
            verifiedVoucherDiscount = (originalPrice * Number(vData.discount_value)) / 100;
            if (vData.max_discount && verifiedVoucherDiscount > Number(vData.max_discount)) {
              verifiedVoucherDiscount = Number(vData.max_discount);
            }
          } else {
            verifiedVoucherDiscount = Number(vData.discount_value);
          }
          verifiedVoucherDiscount = Math.min(originalPrice, Math.round(verifiedVoucherDiscount));
          appliedVoucherCode = vData.code;

          await client.query(
            'UPDATE vouchers SET used_count = used_count + 1 WHERE id = $1',
            [vData.id]
          );
        }
      }
    }

    // 2. Validasi & Hitung Tukar Poin (1 Poin = Rp 1.000)
    const priceAfterVoucher = Math.max(0, originalPrice - verifiedVoucherDiscount);
    const availablePoints = Number(booking.current_points || 0);
    const maxRedeemablePoints = Math.min(availablePoints, Math.floor(priceAfterVoucher / 1000));
    const requestedPoints = Math.max(0, Math.floor(Number(pointsRedeemed) || 0));

    const appliedPoints = Math.min(requestedPoints, maxRedeemablePoints);
    const pointsDiscount = appliedPoints * 1000;
    const totalDiscount = verifiedVoucherDiscount + pointsDiscount;
    const finalPrice = Math.max(0, originalPrice - totalDiscount);

    // Tambah poin perolehan baru dari transaksi lunas (1 Poin tiap Rp 10.000)
    const pointsEarned = Math.floor(finalPrice / 10000);
    let remainingPoints = availablePoints - appliedPoints + pointsEarned;

    if (booking.cust_id) {
      const custUpdate = await client.query(
        `UPDATE customers
         SET loyalty_points = GREATEST(0, COALESCE(loyalty_points, 0) - $1) + $2,
             total_visits = COALESCE(total_visits, 0) + 1,
             total_spend = COALESCE(total_spend, 0) + $3,
             last_visit_at = NOW()
         WHERE id = $4
         RETURNING loyalty_points`,
        [appliedPoints, pointsEarned, finalPrice, booking.cust_id]
      );
      remainingPoints = Number(custUpdate.rows[0]?.loyalty_points ?? remainingPoints);
    }

    await client.query(
      `UPDATE bookings
       SET status = 'CONFIRMED',
           payment_status = 'PAID',
           payment_method = $1,
           points_redeemed = $2,
           voucher_code = $3,
           voucher_discount = $4,
           discount_amount = $5,
           final_price = $6,
           paid_at = NOW()
       WHERE id = $7`,
      [
        paymentMethod,
        appliedPoints,
        appliedVoucherCode,
        verifiedVoucherDiscount,
        totalDiscount,
        finalPrice,
        booking.id,
      ]
    );

    await client.query('COMMIT');

    const summaryText = booking.items_summary || 'Treatment Barbershop';

    if (booking.customer_phone && !String(booking.customer_phone).startsWith('WA-')) {
      try {
        await sendBookingConfirmationWA({
          phone: booking.customer_phone,
          customerName: booking.customer_name || 'Pelanggan',
          bookingCode: booking.booking_code,
          serviceName: `${summaryText} (${booking.outlet_name || 'Cabang Utama'})`,
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
        voucherCode: appliedVoucherCode,
        voucherDiscount: verifiedVoucherDiscount,
        pointsRedeemed: appliedPoints,
        pointsEarned,
        discountAmount: totalDiscount,
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

// POST /api/v1/bookings/:id/cancel
export const cancelOrExpireBooking = async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    await pool.query(
      `UPDATE bookings
       SET status = 'EXPIRED'
       WHERE (id::text = $1 OR booking_code = $1) AND UPPER(status) = 'PENDING_PAYMENT'`,
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

// GET /api/v1/bookings/customer-history?customerId=... (Riwayat Pemesanan Pelanggan)
export const getCustomerBookingHistory = async (req: Request, res: Response) => {
  try {
    await cleanupExpiredBookings();
    const { customerId } = req.query;
    if (!customerId) {
      return res.status(400).json({ success: false, message: 'customerId wajib diisi' });
    }

    const result = await pool.query(
      `SELECT
         b.id,
         b.booking_code,
         COALESCE(b.outlet_name, 'Cabang Makassar') AS outlet_name,
         b.booking_date::text AS booking_date,
         b.start_time,
         b.end_time,
         b.status,
         COALESCE(b.payment_status, 'UNPAID') AS payment_status,
         COALESCE(b.payment_method, '-') AS payment_method,
         b.expires_at,
         COALESCE(b.items_summary, s.name, 'Layanan Cukur') AS items_summary,
         COALESCE(b.subtotal_price, s.base_price, 0) AS subtotal_price,
         COALESCE(b.discount_amount, 0) AS discount_amount,
         COALESCE(b.final_price, s.base_price, 0) AS final_price,
         COALESCE(b.points_redeemed, 0) AS points_redeemed,
         b.voucher_code,
         COALESCE(bar.nickname, 'Kapster') AS barber_name,
         b.created_at
       FROM bookings b
       LEFT JOIN barbers bar ON b.barber_id = bar.id
       LEFT JOIN LATERAL (
         SELECT srv.name, srv.base_price
         FROM booking_items bi
         JOIN services srv ON bi.service_id = srv.id
         WHERE bi.booking_id = b.id
         LIMIT 1
       ) s ON true
       WHERE b.customer_id = $1
       ORDER BY b.created_at DESC NULLS LAST, b.booking_date DESC
       LIMIT 30`,
      [customerId]
    );

    return res.json({ success: true, data: result.rows });
  } catch (err: any) {
    return res.status(500).json({ success: false, message: err.message });
  }
};

// GET /api/v1/bookings/active
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
        COALESCE(b.outlet_name, 'Cabang Utama') AS outlet_name,
        bi.service_id,
        COALESCE(b.items_summary, s.name, 'Layanan') AS service_name,
        COALESCE(b.final_price, s.base_price, 0) AS base_price,
        COALESCE(s.default_commission_percent, 0) AS default_commission_percent,
        COALESCE(bar.nickname, 'Kapster') AS barber_name
      FROM bookings b
      LEFT JOIN customers c ON b.customer_id = c.id
      LEFT JOIN LATERAL (
        SELECT service_id FROM booking_items WHERE booking_id = b.id LIMIT 1
      ) bi ON true
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