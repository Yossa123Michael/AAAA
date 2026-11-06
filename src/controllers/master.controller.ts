import type { Request, Response } from 'express';
import { pool } from '../db';

const DEFAULT_OUTLET = '22222222-2222-2222-2222-222222222222';

// ==================== 1. SERVICES (LAYANAN) ====================

// GET /api/v1/master/services
export const getAllServices = async (req: Request, res: Response) => {
  try {
    const result = await pool.query(
      `SELECT 
        id, 
        code, 
        name, 
        base_price, 
        COALESCE(duration_minutes, 45) AS duration_minutes,
        COALESCE(default_commission_percent, 0) AS default_commission_percent, 
        COALESCE(is_active, true) AS is_active 
       FROM services 
       ORDER BY code ASC`
    );
    res.json({ success: true, data: result.rows });
  } catch (err: any) {
    res.status(500).json({ success: false, message: err.message });
  }
};

// POST /api/v1/master/services
export const createService = async (req: Request, res: Response) => {
  try {
    const { 
      code, 
      name, 
      basePrice, 
      base_price, 
      durationMinutes, 
      duration_minutes, 
      defaultCommissionPercent, 
      default_commission_percent 
    } = req.body;

    const finalName = name?.trim();
    const finalPrice = Number(basePrice ?? base_price);
    const finalCode = (code || `SRV-${Date.now().toString().slice(-4)}`).toUpperCase();
    const finalDuration = Number(durationMinutes ?? duration_minutes ?? 45);
    const finalCommission = Number(defaultCommissionPercent ?? default_commission_percent ?? 0);

    if (!finalName || isNaN(finalPrice)) {
      return res.status(400).json({ success: false, message: 'Nama dan harga layanan wajib diisi dengan benar' });
    }

    // Mengambil category_id yang tersedia secara otomatis agar tidak melanggar batasan NOT NULL
    const result = await pool.query(
      `INSERT INTO services (
        tenant_id, 
        category_id, 
        code, 
        name, 
        base_price, 
        duration_minutes, 
        default_commission_percent, 
        is_active
      ) VALUES (
        (SELECT tenant_id FROM outlets LIMIT 1),
        (SELECT category_id FROM services WHERE category_id IS NOT NULL LIMIT 1),
        $1, $2, $3, $4, $5, true
      ) RETURNING id, code, name, base_price, duration_minutes, default_commission_percent, is_active`,
      [finalCode, finalName, finalPrice, finalDuration, finalCommission]
    );

    res.status(201).json({ 
      success: true, 
      message: 'Layanan baru berhasil ditambahkan', 
      data: result.rows[0] 
    });
  } catch (err: any) {
    res.status(500).json({ success: false, message: err.message });
  }
};

// PUT /api/v1/master/services/:id
export const updateService = async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const { 
      code, 
      name, 
      basePrice, 
      base_price, 
      durationMinutes, 
      duration_minutes, 
      defaultCommissionPercent, 
      default_commission_percent, 
      isActive, 
      is_active 
    } = req.body;

    const finalPrice = basePrice !== undefined ? Number(basePrice) : (base_price !== undefined ? Number(base_price) : undefined);
    const finalDuration = durationMinutes !== undefined ? Number(durationMinutes) : (duration_minutes !== undefined ? Number(duration_minutes) : undefined);
    const finalCommission = defaultCommissionPercent !== undefined ? Number(defaultCommissionPercent) : (default_commission_percent !== undefined ? Number(default_commission_percent) : undefined);
    const finalActive = isActive !== undefined ? isActive : (is_active !== undefined ? is_active : true);

    const result = await pool.query(
      `UPDATE services 
       SET 
         code = COALESCE($1, code),
         name = COALESCE($2, name),
         base_price = COALESCE($3, base_price),
         duration_minutes = COALESCE($4, duration_minutes),
         default_commission_percent = COALESCE($5, default_commission_percent),
         is_active = $6,
         updated_at = NOW()
       WHERE id = $7 
       RETURNING *`,
      [
        code ? code.toUpperCase() : null,
        name || null,
        finalPrice,
        finalDuration,
        finalCommission,
        finalActive,
        id
      ]
    );

    if (result.rowCount === 0) {
      return res.status(404).json({ success: false, message: 'Layanan tidak ditemukan' });
    }

    res.json({ success: true, message: 'Layanan berhasil diperbarui', data: result.rows[0] });
  } catch (err: any) {
    res.status(500).json({ success: false, message: err.message });
  }
};

// DELETE /api/v1/master/services/:id (Soft Delete)
export const deleteService = async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const result = await pool.query('UPDATE services SET is_active = false, updated_at = NOW() WHERE id = $1', [id]);
    if (result.rowCount === 0) return res.status(404).json({ success: false, message: 'Layanan tidak ditemukan' });
    res.json({ success: true, message: 'Layanan berhasil dinonaktifkan' });
  } catch (err: any) {
    res.status(500).json({ success: false, message: err.message });
  }
};

// ==================== 2. PRODUCTS (PRODUK RETAIL) ====================

// GET /api/v1/master/products?outletId=...
export const getAllProducts = async (req: Request, res: Response) => {
  try {
    const { outletId = DEFAULT_OUTLET } = req.query;
    const result = await pool.query(
      `SELECT 
        p.id, 
        p.sku, 
        p.name, 
        COALESCE(p.selling_price, 0) AS selling_price, 
        COALESCE(p.cost_price, 0) AS cost_price, 
        COALESCE(p.default_commission_percent, 0) AS default_commission_percent, 
        COALESCE(s.stock_quantity, 0) AS stock_quantity,
        COALESCE(p.is_active, true) AS is_active
       FROM products p
       LEFT JOIN inventory_stocks s ON p.id = s.product_id AND s.outlet_id = $1
       ORDER BY p.sku ASC`,
      [outletId]
    );
    res.json({ success: true, data: result.rows });
  } catch (err: any) {
    res.status(500).json({ success: false, message: err.message });
  }
};

// POST /api/v1/master/products
export const createProduct = async (req: Request, res: Response) => {
  const client = await pool.connect();
  try {
    const { 
      sku, 
      name, 
      sellingPrice, 
      sell_price, 
      costPrice, 
      cost_price, 
      defaultCommissionPercent, 
      stockQuantity, 
      stock_quantity, 
      outletId = DEFAULT_OUTLET 
    } = req.body;

    const finalName = name?.trim();
    const finalSku = (sku || `SKU-${Date.now().toString().slice(-4)}`).toUpperCase();
    const finalSellPrice = Number(sellingPrice ?? sell_price);
    const finalCostPrice = Number(costPrice ?? cost_price ?? 0);
    const finalCommission = Number(defaultCommissionPercent ?? 0);
    const initialStock = Number(stockQuantity ?? stock_quantity ?? 0);

    if (!finalName || isNaN(finalSellPrice)) {
      return res.status(400).json({ success: false, message: 'SKU, nama, dan harga jual produk wajib diisi' });
    }

    await client.query('BEGIN');

    // Menyisipkan category_id otomatis dari produk yang sudah ada agar tidak melanggar batasan NOT NULL
    const prdRes = await client.query(
      `INSERT INTO products (
        tenant_id, 
        category_id, 
        sku, 
        name, 
        selling_price, 
        cost_price, 
        default_commission_percent, 
        is_active
      ) VALUES (
        (SELECT tenant_id FROM outlets LIMIT 1),
        (SELECT category_id FROM products WHERE category_id IS NOT NULL LIMIT 1),
        $1, $2, $3, $4, $5, true
      ) RETURNING id, sku, name, selling_price, cost_price, default_commission_percent`,
      [finalSku, finalName, finalSellPrice, finalCostPrice, finalCommission]
    );
    const newProduct = prdRes.rows[0];

    // Inisialisasi slot stok outlet
    await client.query(
      `INSERT INTO inventory_stocks (outlet_id, product_id, stock_quantity, min_stock_alert, updated_at)
       VALUES ($1, $2, $3, 5, NOW())
       ON CONFLICT (outlet_id, product_id) DO UPDATE SET stock_quantity = $3, updated_at = NOW()`,
      [outletId, newProduct.id, initialStock]
    );

    await client.query('COMMIT');
    res.status(201).json({ 
      success: true, 
      message: 'Produk berhasil ditambahkan', 
      data: { ...newProduct, stock_quantity: initialStock } 
    });
  } catch (err: any) {
    await client.query('ROLLBACK');
    res.status(500).json({ success: false, message: err.message });
  } finally {
    client.release();
  }
};

// PUT /api/v1/master/products/:id
export const updateProduct = async (req: Request, res: Response) => {
  const client = await pool.connect();
  try {
    const { id } = req.params;
    const { 
      sku, 
      name, 
      sellingPrice, 
      sell_price, 
      costPrice, 
      cost_price, 
      defaultCommissionPercent, 
      stockQuantity, 
      stock_quantity, 
      isActive, 
      is_active, 
      outletId = DEFAULT_OUTLET 
    } = req.body;

    const finalSellPrice = sellingPrice !== undefined ? Number(sellingPrice) : (sell_price !== undefined ? Number(sell_price) : undefined);
    const finalCostPrice = costPrice !== undefined ? Number(costPrice) : (cost_price !== undefined ? Number(cost_price) : undefined);
    const finalCommission = defaultCommissionPercent !== undefined ? Number(defaultCommissionPercent) : undefined;
    const finalActive = isActive !== undefined ? isActive : (is_active !== undefined ? is_active : true);

    await client.query('BEGIN');

    const result = await client.query(
      `UPDATE products 
       SET 
         sku = COALESCE($1, sku),
         name = COALESCE($2, name),
         selling_price = COALESCE($3, selling_price),
         cost_price = COALESCE($4, cost_price),
         default_commission_percent = COALESCE($5, default_commission_percent),
         is_active = $6,
         updated_at = NOW()
       WHERE id = $7 
       RETURNING *`,
      [
        sku ? sku.toUpperCase() : null,
        name || null,
        finalSellPrice,
        finalCostPrice,
        finalCommission,
        finalActive,
        id
      ]
    );

    if (result.rowCount === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ success: false, message: 'Produk tidak ditemukan' });
    }

    const targetStock = stockQuantity !== undefined ? Number(stockQuantity) : (stock_quantity !== undefined ? Number(stock_quantity) : undefined);
    if (targetStock !== undefined) {
      await client.query(
        `INSERT INTO inventory_stocks (outlet_id, product_id, stock_quantity, updated_at)
         VALUES ($1, $2, $3, NOW())
         ON CONFLICT (outlet_id, product_id) DO UPDATE SET stock_quantity = $3, updated_at = NOW()`,
        [outletId, id, targetStock]
      );
    }

    await client.query('COMMIT');
    res.json({ success: true, message: 'Produk berhasil diperbarui', data: result.rows[0] });
  } catch (err: any) {
    await client.query('ROLLBACK');
    res.status(500).json({ success: false, message: err.message });
  } finally {
    client.release();
  }
};

// DELETE /api/v1/master/products/:id (Soft Delete)
export const deleteProduct = async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const result = await pool.query('UPDATE products SET is_active = false, updated_at = NOW() WHERE id = $1', [id]);
    if (result.rowCount === 0) return res.status(404).json({ success: false, message: 'Produk tidak ditemukan' });
    res.json({ success: true, message: 'Produk berhasil dinonaktifkan' });
  } catch (err: any) {
    res.status(500).json({ success: false, message: err.message });
  }
};

// ==================== 3. BARBERS (KAPSTER) ====================

// GET /api/v1/master/barbers?outletId=...
export const getAllBarbers = async (req: Request, res: Response) => {
  try {
    const { outletId = DEFAULT_OUTLET } = req.query;
    const result = await pool.query(
      `SELECT id, nickname, level, COALESCE(is_active, true) AS is_active 
       FROM barbers 
       WHERE outlet_id = $1 
       ORDER BY nickname ASC`,
      [outletId]
    );
    res.json({ success: true, data: result.rows });
  } catch (err: any) {
    res.status(500).json({ success: false, message: err.message });
  }
};

// POST /api/v1/master/barbers
export const createBarber = async (req: Request, res: Response) => {
  try {
    const { nickname, level, outletId = DEFAULT_OUTLET } = req.body;
    if (!nickname || !nickname.trim()) {
      return res.status(400).json({ success: false, message: 'Nama panggilan kapster wajib diisi' });
    }

    const result = await pool.query(
      `INSERT INTO barbers (
        tenant_id, outlet_id, nickname, level, is_active
      ) VALUES (
        (SELECT tenant_id FROM outlets WHERE id = $1),
        $1, $2, $3, true
      ) RETURNING id, nickname, level, is_active`,
      [outletId, nickname.trim(), level || 'SENIOR']
    );

    res.status(201).json({ success: true, message: 'Kapster berhasil didaftarkan', data: result.rows[0] });
  } catch (err: any) {
    res.status(500).json({ success: false, message: err.message });
  }
};

// PUT /api/v1/master/barbers/:id
export const updateBarber = async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const { nickname, level, isActive, is_active } = req.body;

    const finalActive = isActive !== undefined ? isActive : (is_active !== undefined ? is_active : true);

    const result = await pool.query(
      `UPDATE barbers 
       SET 
         nickname = COALESCE($1, nickname),
         level = COALESCE($2, level),
         is_active = $3,
         updated_at = NOW()
       WHERE id = $4 
       RETURNING *`,
      [nickname ? nickname.trim() : null, level || null, finalActive, id]
    );

    if (result.rowCount === 0) {
      return res.status(404).json({ success: false, message: 'Kapster tidak ditemukan' });
    }

    res.json({ success: true, message: 'Data kapster berhasil diperbarui', data: result.rows[0] });
  } catch (err: any) {
    res.status(500).json({ success: false, message: err.message });
  }
};

// DELETE /api/v1/master/barbers/:id (Soft Delete)
export const deleteBarber = async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const result = await pool.query('UPDATE barbers SET is_active = false, updated_at = NOW() WHERE id = $1', [id]);
    if (result.rowCount === 0) return res.status(404).json({ success: false, message: 'Kapster tidak ditemukan' });
    res.json({ success: true, message: 'Kapster berhasil dinonaktifkan' });
  } catch (err: any) {
    res.status(500).json({ success: false, message: err.message });
  }
};

// GET /api/v1/master/vouchers
export const getAllVouchers = async (req: Request, res: Response) => {
  try {
    const result = await pool.query(
      `SELECT * FROM vouchers ORDER BY created_at DESC`
    );
    return res.json({ success: true, data: result.rows });
  } catch (error: any) {
    return res.status(500).json({ success: false, message: error.message });
  }
};

// POST /api/v1/master/vouchers
export const createVoucher = async (req: Request, res: Response) => {
  try {
    const {
      code,
      discountType,
      discountValue,
      minSpend,
      maxDiscount,
      usageLimit,
      endDate,
    } = req.body;

    if (!code || !discountType || !discountValue || !endDate) {
      return res.status(400).json({
        success: false,
        message: 'Kode voucher, tipe diskon, nilai diskon, dan tanggal berakhir wajib diisi.',
      });
    }

    const cleanCode = String(code).trim().toUpperCase();

    const query = `
      INSERT INTO vouchers (
        code, discount_type, discount_value, min_spend, max_discount, usage_limit, end_date
      ) VALUES ($1, $2, $3, $4, $5, $6, $7)
      RETURNING *
    `;

    const values = [
      cleanCode,
      discountType,
      Number(discountValue),
      Number(minSpend || 0),
      maxDiscount ? Number(maxDiscount) : null,
      usageLimit ? Number(usageLimit) : null,
      endDate,
    ];

    const result = await pool.query(query, values);
    return res.status(201).json({
      success: true,
      message: 'Voucher baru berhasil dibuat!',
      data: result.rows[0],
    });
  } catch (error: any) {
    if (error.code === '23505') {
      return res.status(400).json({ success: false, message: 'Kode voucher sudah terdaftar!' });
    }
    return res.status(500).json({ success: false, message: error.message });
  }
};

// PATCH /api/v1/master/vouchers/:id/toggle
export const toggleVoucherStatus = async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const result = await pool.query(
      `UPDATE vouchers SET is_active = NOT is_active WHERE id = $1 RETURNING id, code, is_active`,
      [id]
    );

    if (result.rowCount === 0) {
      return res.status(404).json({ success: false, message: 'Voucher tidak ditemukan' });
    }

    return res.json({
      success: true,
      message: `Status voucher ${result.rows[0].code} diperbarui!`,
      data: result.rows[0],
    });
  } catch (error: any) {
    return res.status(500).json({ success: false, message: error.message });
  }
};