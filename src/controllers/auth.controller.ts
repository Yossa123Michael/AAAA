import type { Request, Response } from 'express';
import { pool } from '../db';

// 1. POST /api/v1/auth/login
// Mendukung Auto-Detect Role dari Database (seperti Spotify / Aplikasi Modern):
// Mengecek tabel users (OWNER/CASHIER) -> barbers (BARBER) -> customers (CUSTOMER)
export const login = async (req: Request, res: Response) => {
  try {
    const { identifier, email, password, role } = req.body;
    const loginId = (identifier || email || '').trim();
    const targetRole = (role || 'AUTO').toUpperCase();

    if (!loginId || !password) {
      return res.status(400).json({
        success: false,
        message: 'Email, username, atau nomor telepon dan password wajib diisi',
      });
    }

    // ==================== 1. CEK TABEL STAF (OWNER & KASIR) ====================
    if (targetRole === 'AUTO' || targetRole === 'OWNER' || targetRole === 'CASHIER') {
      const userRes = await pool.query(
        `SELECT 
          id, 
          tenant_id, 
          outlet_id, 
          COALESCE(name, full_name) AS name, 
          email,
          username,
          phone,
          COALESCE(role, 'CASHIER') AS role, 
          COALESCE(password, password_hash) AS password 
         FROM users 
         WHERE LOWER(TRIM(COALESCE(email, ''))) = LOWER($1)
            OR LOWER(TRIM(COALESCE(username, ''))) = LOWER($1)
            OR LOWER(TRIM(COALESCE(phone, ''))) = LOWER($1)
            OR LOWER(TRIM(COALESCE(name, full_name, ''))) = LOWER($1)
         LIMIT 1`,
        [loginId]
      );

      if (userRes.rowCount && userRes.rowCount > 0) {
        const user = userRes.rows[0];
        if (String(user.password).trim() !== String(password).trim()) {
          return res.status(401).json({
            success: false,
            message: 'Password salah untuk akun staf ini.',
          });
        }

        const dbRole = String(user.role).toUpperCase();
        return res.json({
          success: true,
          message: `Selamat datang kembali, ${user.name}!`,
          data: {
            id: user.id,
            name: user.name,
            email: user.email,
            username: user.username,
            phone: user.phone,
            role: dbRole,
            outletId: user.outlet_id,
            token: `jwt-staff-${user.id}-${Date.now()}`,
          },
        });
      }
    }

    // ==================== 2. CEK TABEL KAPSTER (BARBER) ====================
    if (targetRole === 'AUTO' || targetRole === 'BARBER') {
      const barberRes = await pool.query(
        `SELECT 
          id,
          outlet_id,
          nickname,
          level,
          username,
          email,
          phone,
          COALESCE(password, 'kapster123') AS password
         FROM barbers
         WHERE COALESCE(is_active, true) = true
           AND (
             LOWER(TRIM(COALESCE(nickname, ''))) = LOWER($1)
             OR LOWER(TRIM(COALESCE(username, ''))) = LOWER($1)
             OR LOWER(TRIM(COALESCE(email, ''))) = LOWER($1)
             OR LOWER(TRIM(COALESCE(phone, ''))) = LOWER($1)
           )
         LIMIT 1`,
        [loginId]
      );

      if (barberRes.rowCount && barberRes.rowCount > 0) {
        const barber = barberRes.rows[0];
        if (String(barber.password).trim() !== String(password).trim()) {
          return res.status(401).json({
            success: false,
            message: 'Password Kapster salah.',
          });
        }

        return res.json({
          success: true,
          message: `Selamat bertugas, Kapster ${barber.nickname}!`,
          data: {
            id: barber.id,
            barber_id: barber.id,
            name: barber.nickname,
            email: barber.email,
            phone: barber.phone,
            level: barber.level,
            role: 'BARBER',
            outletId: barber.outlet_id,
            token: `jwt-barber-${barber.id}-${Date.now()}`,
          },
        });
      }
    }

    // ==================== 3. CEK TABEL PELANGGAN (CUSTOMER) ====================
    if (targetRole === 'AUTO' || targetRole === 'CUSTOMER') {
      const custRes = await pool.query(
        `SELECT 
          id,
          full_name,
          phone,
          email,
          username,
          COALESCE(password, 'member123') AS password,
          COALESCE(loyalty_points, 0) AS loyalty_points,
          COALESCE(total_visits, 0) AS total_visits,
          haircut_notes,
          COALESCE(auth_provider, 'LOCAL') AS auth_provider,
          avatar_url
         FROM customers
         WHERE LOWER(TRIM(COALESCE(phone, ''))) = LOWER($1)
            OR LOWER(TRIM(COALESCE(email, ''))) = LOWER($1)
            OR LOWER(TRIM(COALESCE(username, ''))) = LOWER($1)
            OR LOWER(TRIM(COALESCE(full_name, ''))) = LOWER($1)
         LIMIT 1`,
        [loginId]
      );

      if (custRes.rowCount && custRes.rowCount > 0) {
        const cust = custRes.rows[0];
        if (String(cust.password).trim() !== String(password).trim()) {
          return res.status(401).json({
            success: false,
            message: 'Password pelanggan salah.',
          });
        }

        return res.json({
          success: true,
          message: `Welcome back, ${cust.full_name}!`,
          data: {
            id: cust.id,
            customerId: cust.id,
            name: cust.full_name,
            full_name: cust.full_name,
            phone: cust.phone,
            email: cust.email,
            username: cust.username,
            role: 'CUSTOMER',
            loyalty_points: Number(cust.loyalty_points || 0),
            total_visits: Number(cust.total_visits || 0),
            haircut_notes: cust.haircut_notes || '',
            authProvider: cust.auth_provider,
            avatarUrl: cust.avatar_url,
            token: `jwt-cust-${cust.id}-${Date.now()}`,
          },
        });
      }
    }

    return res.status(401).json({
      success: false,
      message: 'Akun tidak ditemukan. Periksa kembali email/username/nomor telepon Anda atau klik Daftar.',
    });
  } catch (err: any) {
    return res.status(500).json({ success: false, message: err.message });
  }
};

// 2. POST /api/v1/auth/register-customer (Pendaftaran Member Pelanggan Baru)
export const registerCustomer = async (req: Request, res: Response) => {
  try {
    const { fullName, phone, email, username, password, haircutNotes } = req.body;

    if (!fullName || !phone || !password) {
      return res.status(400).json({
        success: false,
        message: 'Nama lengkap, nomor telepon, dan password wajib diisi.',
      });
    }

    const cleanPhone = String(phone).trim();
    const cleanEmail = email ? String(email).trim().toLowerCase() : null;
    const cleanUsername = username
      ? String(username).trim().toLowerCase()
      : cleanEmail
      ? cleanEmail.split('@')[0]
      : cleanPhone;

    const existing = await pool.query(
      `SELECT id FROM customers WHERE phone = $1 LIMIT 1`,
      [cleanPhone]
    );

    let customer;
    if (existing.rowCount && existing.rowCount > 0) {
      const updated = await pool.query(
        `UPDATE customers
         SET full_name = $1,
             email = COALESCE($2, email),
             username = COALESCE($3, username),
             password = $4,
             haircut_notes = COALESCE($5, haircut_notes),
             auth_provider = 'LOCAL'
         WHERE id = $6
         RETURNING id, full_name, phone, email, username, COALESCE(loyalty_points, 0) AS loyalty_points, COALESCE(total_visits, 0) AS total_visits, haircut_notes`,
        [fullName.trim(), cleanEmail, cleanUsername, password.trim(), haircutNotes || null, existing.rows[0].id]
      );
      customer = updated.rows[0];
    } else {
      const inserted = await pool.query(
        `INSERT INTO customers (
          tenant_id, full_name, phone, email, username, password, haircut_notes, loyalty_points, total_visits, total_spend, auth_provider
        ) VALUES (
          (SELECT tenant_id FROM outlets LIMIT 1),
          $1, $2, $3, $4, $5, $6, 10, 0, 0, 'LOCAL'
        )
        RETURNING id, full_name, phone, email, username, loyalty_points, total_visits, haircut_notes`,
        [fullName.trim(), cleanPhone, cleanEmail, cleanUsername, password.trim(), haircutNotes || null]
      );
      customer = inserted.rows[0];
    }

    return res.status(201).json({
      success: true,
      message: 'Pendaftaran berhasil! Selamat datang di Barbershop OS.',
      data: {
        id: customer.id,
        customerId: customer.id,
        name: customer.full_name,
        full_name: customer.full_name,
        phone: customer.phone,
        email: customer.email,
        username: customer.username,
        role: 'CUSTOMER',
        loyalty_points: Number(customer.loyalty_points || 0),
        total_visits: Number(customer.total_visits || 0),
        haircut_notes: customer.haircut_notes || '',
        authProvider: 'LOCAL',
        token: `jwt-cust-${customer.id}-${Date.now()}`,
      },
    });
  } catch (err: any) {
    return res.status(500).json({ success: false, message: err.message });
  }
};

// 3. POST /api/v1/auth/social-login (Google, Facebook, Apple OAuth)
export const socialLogin = async (req: Request, res: Response) => {
  try {
    const {
      provider = 'GOOGLE',
      email,
      name,
      phone,
      providerId,
      avatarUrl,
    } = req.body;

    const cleanProvider = String(provider).toUpperCase();

    if (!email && !name) {
      return res.status(400).json({
        success: false,
        message: 'Data profil akun sosial (nama/email) diperlukan.',
      });
    }

    const cleanEmail = (email || `${String(name).toLowerCase().replace(/[^a-z0-9]/g, '')}@gmail.com`).trim().toLowerCase();
    const displayName = (name || cleanEmail.split('@')[0]).trim();

    // Cek apakah email ini milik Owner / Kasir di tabel users
    const staffCheck = await pool.query(
      `SELECT id, outlet_id, COALESCE(name, full_name) AS name, email, COALESCE(role, 'CASHIER') AS role
       FROM users
       WHERE LOWER(TRIM(COALESCE(email, ''))) = $1
       LIMIT 1`,
      [cleanEmail]
    );

    if (staffCheck.rowCount && staffCheck.rowCount > 0) {
      const u = staffCheck.rows[0];
      return res.json({
        success: true,
        message: `Welcome back, ${u.name}!`,
        data: {
          id: u.id,
          name: u.name,
          email: u.email,
          role: String(u.role).toUpperCase(),
          authProvider: cleanProvider,
          outletId: u.outlet_id,
          token: `jwt-staff-social-${u.id}-${Date.now()}`,
        },
      });
    }

    // Cek apakah email ini milik Kapster di tabel barbers
    const barberCheck = await pool.query(
      `SELECT id, outlet_id, nickname, level, email, phone
       FROM barbers
       WHERE COALESCE(is_active, true) = true
         AND LOWER(TRIM(COALESCE(email, ''))) = $1
       LIMIT 1`,
      [cleanEmail]
    );

    if (barberCheck.rowCount && barberCheck.rowCount > 0) {
      const b = barberCheck.rows[0];
      return res.json({
        success: true,
        message: `Selamat bertugas, Kapster ${b.nickname}!`,
        data: {
          id: b.id,
          barber_id: b.id,
          name: b.nickname,
          email: b.email,
          phone: b.phone,
          level: b.level,
          role: 'BARBER',
          authProvider: cleanProvider,
          outletId: b.outlet_id,
          token: `jwt-barber-social-${b.id}-${Date.now()}`,
        },
      });
    }

    // Jika bukan staf/kapster, login/daftarkan otomatis sebagai Pelanggan (Customer) di tabel customers
    const existingCust = await pool.query(
      `SELECT id, full_name, phone, email, username, COALESCE(loyalty_points, 0) AS loyalty_points, COALESCE(total_visits, 0) AS total_visits, haircut_notes
       FROM customers
       WHERE LOWER(TRIM(COALESCE(email, ''))) = $1
          OR (provider_id IS NOT NULL AND provider_id = $2)
          OR ($3::text IS NOT NULL AND phone = $3)
       LIMIT 1`,
      [cleanEmail, providerId || cleanEmail, phone || null]
    );

    let cust;
    if (existingCust.rowCount && existingCust.rowCount > 0) {
      const updated = await pool.query(
        `UPDATE customers
         SET email = COALESCE(email, $1),
             auth_provider = $2,
             provider_id = COALESCE(provider_id, $3),
             avatar_url = COALESCE($4, avatar_url)
         WHERE id = $5
         RETURNING id, full_name, phone, email, username, COALESCE(loyalty_points, 0) AS loyalty_points, COALESCE(total_visits, 0) AS total_visits, haircut_notes, auth_provider, avatar_url`,
        [cleanEmail, cleanProvider, providerId || cleanEmail, avatarUrl || null, existingCust.rows[0].id]
      );
      cust = updated.rows[0];
    } else {
      const generatedPhone =
        phone && String(phone).trim()
          ? String(phone).trim()
          : `0812${Math.floor(10000000 + Math.random() * 90000000)}`;
      const username = cleanEmail.split('@')[0];

      const inserted = await pool.query(
        `INSERT INTO customers (
          tenant_id, full_name, phone, email, username, password, loyalty_points, total_visits, total_spend, auth_provider, provider_id, avatar_url
        ) VALUES (
          (SELECT tenant_id FROM outlets LIMIT 1),
          $1, $2, $3, $4, 'social-auth', 10, 0, 0, $5, $6, $7
        )
        RETURNING id, full_name, phone, email, username, loyalty_points, total_visits, haircut_notes, auth_provider, avatar_url`,
        [displayName, generatedPhone, cleanEmail, username, cleanProvider, providerId || cleanEmail, avatarUrl || null]
      );
      cust = inserted.rows[0];
    }

    return res.json({
      success: true,
      message: `Berhasil masuk melalui ${cleanProvider}!`,
      data: {
        id: cust.id,
        customerId: cust.id,
        name: cust.full_name,
        full_name: cust.full_name,
        phone: cust.phone,
        email: cust.email,
        username: cust.username,
        role: 'CUSTOMER',
        loyalty_points: Number(cust.loyalty_points || 0),
        total_visits: Number(cust.total_visits || 0),
        haircut_notes: cust.haircut_notes || '',
        authProvider: cust.auth_provider || cleanProvider,
        avatarUrl: cust.avatar_url,
        token: `jwt-social-${cust.id}-${Date.now()}`,
      },
    });
  } catch (err: any) {
    return res.status(500).json({ success: false, message: err.message });
  }
};
