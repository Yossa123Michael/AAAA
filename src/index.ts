import { pool } from './db';

// 1. Auto-fix constraint status transaksi
pool.query(`
  ALTER TABLE transactions DROP CONSTRAINT IF EXISTS transactions_status_check;
  ALTER TABLE transactions ADD CONSTRAINT transactions_status_check 
    CHECK (UPPER(status) IN ('PAID', 'COMPLETED', 'PENDING', 'VOID', 'FAILED', 'SUCCESS'));
`)
  .then(() => console.log('>>> [DB FIX] Constraint transactions_status_check BERHASIL diperbarui! 🚀'))
  .catch((err) => console.error('>>> [DB FIX ERROR]', err));

// 2. Auto-fix constraints category_id pada services & products
pool.query(`
  ALTER TABLE services ALTER COLUMN category_id DROP NOT NULL;
`)
  .then(() => console.log('>>> [DB FIX] Kolom category_id pada services berhasil diubah menjadi opsional! 🚀'))
  .catch((err) => console.error('>>> [DB FIX ERROR]', err));

pool.query(`
  ALTER TABLE products ALTER COLUMN category_id DROP NOT NULL;
`)
  .then(() => console.log('>>> [DB FIX] Kolom category_id pada products berhasil diubah menjadi opsional! 🚀'))
  .catch((err) => console.error('>>> [DB FIX ERROR]', err));

// 3. Auto-create tabel roster & cuti kapster
pool.query(`
  CREATE TABLE IF NOT EXISTS barber_weekly_off (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    barber_id UUID NOT NULL REFERENCES barbers(id) ON DELETE CASCADE,
    day_of_week INT NOT NULL, -- 0: Minggu, 1: Senin, 2: Selasa, ..., 6: Sabtu
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    UNIQUE(barber_id, day_of_week)
  );

  CREATE TABLE IF NOT EXISTS barber_leaves (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    barber_id UUID NOT NULL REFERENCES barbers(id) ON DELETE CASCADE,
    leave_date DATE NOT NULL,
    reason VARCHAR(255),
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    UNIQUE(barber_id, leave_date)
  );
`)
  .then(() => console.log('>>> [DB FIX] Tabel barber_weekly_off & barber_leaves SIAP! 🚀'))
  .catch((err) => console.error('>>> [DB ERROR Roster]', err));

// 4. Auto-create tabel vouchers & kolom diskon pada transactions
pool.query(`
  CREATE TABLE IF NOT EXISTS public.vouchers (
    id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
    code VARCHAR(50) UNIQUE NOT NULL,
    discount_type VARCHAR(20) NOT NULL CHECK (discount_type IN ('PERCENTAGE', 'FIXED')),
    discount_value NUMERIC(14,2) NOT NULL CHECK (discount_value > 0),
    min_spend NUMERIC(14,2) DEFAULT 0.00 NOT NULL,
    max_discount NUMERIC(14,2) DEFAULT NULL,
    usage_limit INT DEFAULT NULL,
    used_count INT DEFAULT 0 NOT NULL,
    start_date DATE NOT NULL DEFAULT CURRENT_DATE,
    end_date DATE NOT NULL,
    is_active BOOLEAN DEFAULT TRUE NOT NULL,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP NOT NULL
  );

  ALTER TABLE public.transactions 
    ADD COLUMN IF NOT EXISTS voucher_id UUID REFERENCES public.vouchers(id) ON DELETE SET NULL,
    ADD COLUMN IF NOT EXISTS discount_reason VARCHAR(255) DEFAULT NULL;

  INSERT INTO public.vouchers (code, discount_type, discount_value, min_spend, max_discount, usage_limit, end_date)
  VALUES 
    ('HEMAT20K', 'FIXED', 20000, 50000, NULL, 50, '2026-12-31'),
    ('DISKON10', 'PERCENTAGE', 10, 30000, 15000, 100, '2026-12-31')
  ON CONFLICT (code) DO NOTHING;
`)
  .then(() => console.log('>>> [DB FIX] Tabel vouchers & data kupon awal SIAP! 🚀'))
  .catch((err) => console.error('>>> [DB ERROR Vouchers]', err));

// 5. Auto-upgrade kolom Autentikasi Multi-Role (Customer, Kapster, Kasir, Owner) & Social Login
pool.query(`
  ALTER TABLE public.customers
    ADD COLUMN IF NOT EXISTS email VARCHAR(150) DEFAULT NULL,
    ADD COLUMN IF NOT EXISTS username VARCHAR(100) DEFAULT NULL,
    ADD COLUMN IF NOT EXISTS password VARCHAR(255) DEFAULT 'member123',
    ADD COLUMN IF NOT EXISTS auth_provider VARCHAR(50) DEFAULT 'LOCAL',
    ADD COLUMN IF NOT EXISTS provider_id VARCHAR(150) DEFAULT NULL,
    ADD COLUMN IF NOT EXISTS avatar_url TEXT DEFAULT NULL;

  UPDATE public.customers
  SET 
    email = COALESCE(email, 'pelanggan@gmail.com'),
    username = COALESCE(username, 'johndoe'),
    password = COALESCE(password, 'member123')
  WHERE phone = '081299887766';

  ALTER TABLE public.barbers
    ADD COLUMN IF NOT EXISTS username VARCHAR(100) DEFAULT NULL,
    ADD COLUMN IF NOT EXISTS email VARCHAR(150) DEFAULT NULL,
    ADD COLUMN IF NOT EXISTS phone VARCHAR(50) DEFAULT NULL,
    ADD COLUMN IF NOT EXISTS password VARCHAR(255) DEFAULT 'kapster123';

  UPDATE public.barbers
  SET
    username = COALESCE(username, LOWER(REGEXP_REPLACE(nickname, '[^a-zA-Z0-9]', '', 'g'))),
    email = COALESCE(email, LOWER(REGEXP_REPLACE(nickname, '[^a-zA-Z0-9]', '', 'g')) || '@barber.com'),
    phone = COALESCE(phone, '08130000001'),
    password = COALESCE(password, 'kapster123');

  ALTER TABLE public.users
    ADD COLUMN IF NOT EXISTS username VARCHAR(100) DEFAULT NULL,
    ADD COLUMN IF NOT EXISTS phone VARCHAR(50) DEFAULT NULL;

  UPDATE public.users
  SET username = COALESCE(username, SPLIT_PART(email, '@', 1));
`)
  .then(() => console.log('>>> [DB FIX] Skema Multi-Role Login & Social Auth (Customer/Barber/Staff) SIAP! 🚀'))
  .catch((err) => console.error('>>> [DB ERROR Auth Schema]', err));
