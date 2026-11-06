"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.getActiveBookings = exports.createBooking = exports.getBarberAvailability = void 0;
const db_1 = require("../db");
const availability_1 = require("../services/availability");
// GET /api/v1/bookings/availability?barberId=...&date=YYYY-MM-DD&serviceId=...
const getBarberAvailability = async (req, res) => {
    try {
        const { barberId, date, serviceId } = req.query;
        if (!barberId || !date || !serviceId) {
            return res.status(400).json({ success: false, message: 'Parameter barberId, date, dan serviceId wajib diisi' });
        }
        const bookingDate = new Date(date);
        const dayOfWeek = bookingDate.getDay();
        // 1. Ambil Durasi Layanan & Buffer
        const serviceRes = await db_1.pool.query('SELECT duration_minutes, buffer_minutes FROM services WHERE id = $1', [serviceId]);
        if (serviceRes.rowCount === 0) {
            return res.status(404).json({ success: false, message: 'Layanan tidak ditemukan' });
        }
        const { duration_minutes, buffer_minutes } = serviceRes.rows[0];
        // 2. Ambil Jam Kerja & Istirahat Barber
        const scheduleRes = await db_1.pool.query(`SELECT start_time, end_time, break_start, break_end, is_day_off 
       FROM barber_schedules 
       WHERE barber_id = $1 AND day_of_week = $2`, [barberId, dayOfWeek]);
        if (scheduleRes.rowCount === 0 || scheduleRes.rows[0].is_day_off) {
            return res.json({
                success: true,
                data: { available: false, message: 'Barber libur pada hari ini', slots: [] },
            });
        }
        const schedule = scheduleRes.rows[0];
        // 3. Ambil Booking yang Aktif pada Tanggal Tersebut
        const existingBookingsRes = await db_1.pool.query(`SELECT start_time, end_time 
       FROM bookings 
       WHERE barber_id = $1 AND booking_date = $2 AND status NOT IN ('CANCELLED', 'NO_SHOW')`, [barberId, date]);
        // 4. Kalkulasi Slot Dinamis
        const slots = availability_1.AvailabilityService.generateSlots({
            workStart: schedule.start_time,
            workEnd: schedule.end_time,
            breakStart: schedule.break_start,
            breakEnd: schedule.break_end,
            existingBookings: existingBookingsRes.rows.map((b) => ({
                startTime: b.start_time.slice(0, 5),
                endTime: b.end_time.slice(0, 5),
            })),
            durationMinutes: duration_minutes,
            bufferMinutes: buffer_minutes,
        });
        res.json({
            success: true,
            data: {
                date,
                barberId,
                serviceDuration: duration_minutes,
                bufferMinutes: buffer_minutes,
                slots,
            },
        });
    }
    catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
};
exports.getBarberAvailability = getBarberAvailability;
// POST /api/v1/bookings (Reservasi Baru)
const createBooking = async (req, res) => {
    const client = await db_1.pool.connect();
    try {
        const { outletId, customerName, customerPhone, barberId, serviceId, date, startTime } = req.body;
        if (!outletId || !barberId || !serviceId || !date || !startTime) {
            return res.status(400).json({ success: false, message: 'Data reservasi belum lengkap' });
        }
        await client.query('BEGIN');
        // 1. Cari atau buat customer otomatis berdasarkan nomor HP
        let customerId;
        const existingCust = await client.query('SELECT id FROM customers WHERE phone = $1', [customerPhone || '081299887766']);
        if (existingCust.rowCount && existingCust.rowCount > 0) {
            customerId = existingCust.rows[0].id;
        }
        else {
            const newCust = await client.query(`INSERT INTO customers (tenant_id, phone, full_name, segment, loyalty_points)
         VALUES ((SELECT tenant_id FROM outlets WHERE id = $1), $2, $3, 'NEW', 0)
         RETURNING id`, [outletId, customerPhone, customerName || 'Pelanggan Online']);
            customerId = newCust.rows[0].id;
        }
        // 2. Ambil info layanan & durasi
        const srv = await client.query('SELECT base_price, duration_minutes FROM services WHERE id = $1', [serviceId]);
        if (srv.rowCount === 0)
            throw new Error('Layanan tidak valid');
        const { base_price, duration_minutes } = srv.rows[0];
        // 3. Hitung waktu selesai
        const [h, m] = startTime.split(':').map(Number);
        const endMinutes = h * 60 + m + duration_minutes;
        const endTime = `${Math.floor(endMinutes / 60).toString().padStart(2, '0')}:${(endMinutes % 60).toString().padStart(2, '0')}`;
        // 4. Validasi bentrok slot
        const conflict = await client.query(`SELECT id FROM bookings 
       WHERE barber_id = $1 AND booking_date = $2 
         AND status NOT IN ('CANCELLED', 'NO_SHOW')
         AND (start_time < $4 AND end_time > $3)`, [barberId, date, startTime, endTime]);
        if (conflict.rowCount && conflict.rowCount > 0) {
            throw new Error('Slot jadwal sudah dipesan pelanggan lain. Silakan pilih jam lain.');
        }
        const bookingCode = `BRB-${Date.now().toString().slice(-6)}`;
        // 5. Simpan booking
        const bookingInsert = await client.query(`INSERT INTO bookings (
        outlet_id, booking_code, customer_id, barber_id,
        booking_date, start_time, end_time, status
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, 'CONFIRMED') RETURNING id`, [outletId, bookingCode, customerId, barberId, date, startTime, endTime]);
        await client.query(`INSERT INTO booking_items (booking_id, service_id, price, duration_minutes)
       VALUES ($1, $2, $3, $4)`, [bookingInsert.rows[0].id, serviceId, base_price, duration_minutes]);
        await client.query('COMMIT');
        res.status(201).json({
            success: true,
            message: 'Booking berhasil dikonfirmasi!',
            data: { bookingCode, date, startTime, endTime },
        });
    }
    catch (error) {
        await client.query('ROLLBACK');
        res.status(400).json({ success: false, message: error.message });
    }
    finally {
        client.release();
    }
};
exports.createBooking = createBooking;
// GET /api/v1/bookings/active?outletId=...
const getActiveBookings = async (req, res) => {
    try {
        const { outletId } = req.query;
        const query = `
      SELECT 
        b.id, b.booking_code, b.booking_date, b.start_time, b.end_time, b.status,
        c.id AS customer_id, c.full_name AS customer_name, c.phone AS customer_phone, c.segment,
        bar.id AS barber_id, bar.nickname AS barber_name, bar.level AS barber_level,
        s.id AS service_id, s.name AS service_name, s.base_price, s.default_commission_percent
      FROM bookings b
      JOIN customers c ON b.customer_id = c.id
      JOIN barbers bar ON b.barber_id = bar.id
      JOIN booking_items bi ON b.id = bi.booking_id
      JOIN services s ON bi.service_id = s.id
      WHERE b.outlet_id = $1 AND b.status IN ('CONFIRMED', 'CHECKED_IN')
      ORDER BY b.booking_date ASC, b.start_time ASC
    `;
        const result = await db_1.pool.query(query, [outletId]);
        res.json({
            success: true,
            data: result.rows,
        });
    }
    catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
};
exports.getActiveBookings = getActiveBookings;
