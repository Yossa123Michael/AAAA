"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.deleteBarber = exports.updateBarber = exports.createBarber = exports.getAllBarbers = exports.deleteProduct = exports.updateProduct = exports.createProduct = exports.getAllProducts = exports.deleteService = exports.updateService = exports.createService = exports.getAllServices = void 0;
const db_1 = require("../db");

const DEFAULT_OUTLET = '22222222-2222-2222-2222-222222222222';

// ==================== 1. SERVICES (LAYANAN) ====================

// GET /api/v1/master/services
const getAllServices = async (req, res) => {
    try {
        const result = await db_1.pool.query(`
            SELECT 
                id, 
                code, 
                name, 
                base_price, 
                COALESCE(duration_minutes, 45) AS duration_minutes,
                COALESCE(default_commission_percent, 0) AS default_commission_percent, 
                COALESCE(is_active, true) AS is_active 
            FROM services 
            ORDER BY code ASC
        `);
        res.json({ success: true, data: result.rows });
    }
    catch (err) {
        res.status(500).json({ success: false, message: err.message });
    }
};
exports.getAllServices = getAllServices;

// POST /api/v1/master/services
const createService = async (req, res) => {
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

        const finalName = name ? name.trim() : '';
        const finalPrice = Number(basePrice !== undefined ? basePrice : base_price);
        const finalCode = (code || `SRV-${Date.now().toString().slice(-4)}`).toUpperCase();
        const finalDuration = Number(durationMinutes !== undefined ? durationMinutes : (duration_minutes !== undefined ? duration_minutes : 45));
        const finalCommission = Number(defaultCommissionPercent !== undefined ? defaultCommissionPercent : (default_commission_percent !== undefined ? default_commission_percent : 0));

        if (!finalName || isNaN(finalPrice)) {
            return res.status(400).json({ success: false, message: 'Kode, nama, dan harga layanan wajib diisi' });
        }

        // Menyisipkan category_id otomatis dari data layanan yang sudah ada agar tidak melanggar batasan NOT NULL
        const result = await db_1.pool.query(`
            INSERT INTO services (
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
            ) 
            RETURNING id, code, name, base_price, duration_minutes, default_commission_percent, is_active
        `, [finalCode, finalName, finalPrice, finalDuration, finalCommission]);

        res.status(201).json({ success: true, message: 'Layanan baru berhasil ditambahkan', data: result.rows[0] });
    }
    catch (err) {
        res.status(500).json({ success: false, message: err.message });
    }
};
exports.createService = createService;

// PUT /api/v1/master/services/:id
const updateService = async (req, res) => {
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

        const finalCode = code ? code.toUpperCase() : null;
        const finalPrice = basePrice !== undefined ? Number(basePrice) : (base_price !== undefined ? Number(base_price) : null);
        const finalDuration = durationMinutes !== undefined ? Number(durationMinutes) : (duration_minutes !== undefined ? Number(duration_minutes) : null);
        const finalCommission = defaultCommissionPercent !== undefined ? Number(defaultCommissionPercent) : (default_commission_percent !== undefined ? Number(default_commission_percent) : null);
        const finalActive = isActive !== undefined ? isActive : (is_active !== undefined ? is_active : true);

        const result = await db_1.pool.query(`
            UPDATE services 
            SET 
                code = COALESCE($1, code), 
                name = COALESCE($2, name), 
                base_price = COALESCE($3, base_price), 
                duration_minutes = COALESCE($4, duration_minutes),
                default_commission_percent = COALESCE($5, default_commission_percent), 
                is_active = $6, 
                updated_at = NOW()
            WHERE id = $7 
            RETURNING *
        `, [finalCode, name || null, finalPrice, finalDuration, finalCommission, finalActive, id]);

        if (result.rowCount === 0) {
            return res.status(404).json({ success: false, message: 'Layanan tidak ditemukan' });
        }
        res.json({ success: true, message: 'Layanan berhasil diperbarui', data: result.rows[0] });
    }
    catch (err) {
        res.status(500).json({ success: false, message: err.message });
    }
};
exports.updateService = updateService;

// DELETE /api/v1/master/services/:id
const deleteService = async (req, res) => {
    try {
        const { id } = req.params;
        const result = await db_1.pool.query('UPDATE services SET is_active = false, updated_at = NOW() WHERE id = $1', [id]);
        if (result.rowCount === 0) {
            return res.status(404).json({ success: false, message: 'Layanan tidak ditemukan' });
        }
        res.json({ success: true, message: 'Layanan berhasil dinonaktifkan' });
    }
    catch (err) {
        res.status(500).json({ success: false, message: err.message });
    }
};
exports.deleteService = deleteService;

// ==================== 2. PRODUCTS (PRODUK RETAIL) ====================

// GET /api/v1/master/products?outletId=...
const getAllProducts = async (req, res) => {
    try {
        const { outletId = DEFAULT_OUTLET } = req.query;
        const result = await db_1.pool.query(`
            SELECT 
                p.id, 
                p.sku, 
                p.name, 
                p.selling_price, 
                COALESCE(p.cost_price, 0) AS cost_price, 
                p.default_commission_percent, 
                COALESCE(s.stock_quantity, 0) AS stock_quantity,
                COALESCE(p.is_active, true) AS is_active
            FROM products p
            LEFT JOIN inventory_stocks s ON p.id = s.product_id AND s.outlet_id = $1
            ORDER BY p.sku ASC
        `, [outletId]);
        res.json({ success: true, data: result.rows });
    }
    catch (err) {
        res.status(500).json({ success: false, message: err.message });
    }
};
exports.getAllProducts = getAllProducts;

// POST /api/v1/master/products
const createProduct = async (req, res) => {
    const client = await db_1.pool.connect();
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

        const finalName = name ? name.trim() : '';
        const finalSku = (sku || `SKU-${Date.now().toString().slice(-4)}`).toUpperCase();
        const finalSellPrice = Number(sellingPrice !== undefined ? sellingPrice : sell_price);
        const finalCostPrice = Number(costPrice !== undefined ? costPrice : (cost_price !== undefined ? cost_price : 0));
        const finalCommission = Number(defaultCommissionPercent !== undefined ? defaultCommissionPercent : 0);
        const initialStock = Number(stockQuantity !== undefined ? stockQuantity : (stock_quantity !== undefined ? stock_quantity : 0));

        if (!finalName || isNaN(finalSellPrice)) {
            return res.status(400).json({ success: false, message: 'SKU, nama, dan harga jual produk wajib diisi' });
        }

        await client.query('BEGIN');
        const prdRes = await client.query(`
            INSERT INTO products (tenant_id, sku, name, selling_price, cost_price, default_commission_percent, is_active)
            VALUES (
                (SELECT tenant_id FROM outlets LIMIT 1),
                $1, $2, $3, $4, $5, true
            ) 
            RETURNING id, sku, name, selling_price, cost_price, default_commission_percent
        `, [finalSku, finalName, finalSellPrice, finalCostPrice, finalCommission]);
        const newProduct = prdRes.rows[0];

        // Inisialisasi slot stok outlet
        await client.query(`
            INSERT INTO inventory_stocks (outlet_id, product_id, stock_quantity, min_stock_alert, updated_at)
            VALUES ($1, $2, $3, 5, NOW())
            ON CONFLICT (outlet_id, product_id) DO UPDATE SET stock_quantity = $3, updated_at = NOW()
        `, [outletId, newProduct.id, initialStock]);

        await client.query('COMMIT');
        res.status(201).json({ success: true, message: 'Produk berhasil ditambahkan', data: Object.assign(Object.assign({}, newProduct), { stock_quantity: initialStock }) });
    }
    catch (err) {
        await client.query('ROLLBACK');
        res.status(500).json({ success: false, message: err.message });
    }
    finally {
        client.release();
    }
};
exports.createProduct = createProduct;

// PUT /api/v1/master/products/:id
const updateProduct = async (req, res) => {
    const client = await db_1.pool.connect();
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

        const finalSku = sku ? sku.toUpperCase() : null;
        const finalSellPrice = sellingPrice !== undefined ? Number(sellingPrice) : (sell_price !== undefined ? Number(sell_price) : null);
        const finalCostPrice = costPrice !== undefined ? Number(costPrice) : (cost_price !== undefined ? Number(cost_price) : null);
        const finalCommission = defaultCommissionPercent !== undefined ? Number(defaultCommissionPercent) : null;
        const finalActive = isActive !== undefined ? isActive : (is_active !== undefined ? is_active : true);

        await client.query('BEGIN');
        const result = await client.query(`
            UPDATE products 
            SET 
                sku = COALESCE($1, sku), 
                name = COALESCE($2, name), 
                selling_price = COALESCE($3, selling_price), 
                cost_price = COALESCE($4, cost_price), 
                default_commission_percent = COALESCE($5, default_commission_percent), 
                is_active = $6, 
                updated_at = NOW()
            WHERE id = $7 
            RETURNING *
        `, [finalSku, name || null, finalSellPrice, finalCostPrice, finalCommission, finalActive, id]);

        if (result.rowCount === 0) {
            await client.query('ROLLBACK');
            return res.status(404).json({ success: false, message: 'Produk tidak ditemukan' });
        }

        const targetStock = stockQuantity !== undefined ? Number(stockQuantity) : (stock_quantity !== undefined ? Number(stock_quantity) : undefined);
        if (targetStock !== undefined) {
            await client.query(`
                INSERT INTO inventory_stocks (outlet_id, product_id, stock_quantity, updated_at)
                VALUES ($1, $2, $3, NOW())
                ON CONFLICT (outlet_id, product_id) DO UPDATE SET stock_quantity = $3, updated_at = NOW()
            `, [outletId, id, targetStock]);
        }

        await client.query('COMMIT');
        res.json({ success: true, message: 'Produk berhasil diperbarui', data: result.rows[0] });
    }
    catch (err) {
        await client.query('ROLLBACK');
        res.status(500).json({ success: false, message: err.message });
    }
    finally {
        client.release();
    }
};
exports.updateProduct = updateProduct;

// DELETE /api/v1/master/products/:id
const deleteProduct = async (req, res) => {
    try {
        const { id } = req.params;
        const result = await db_1.pool.query('UPDATE products SET is_active = false, updated_at = NOW() WHERE id = $1', [id]);
        if (result.rowCount === 0) {
            return res.status(404).json({ success: false, message: 'Produk tidak ditemukan' });
        }
        res.json({ success: true, message: 'Produk berhasil dinonaktifkan' });
    }
    catch (err) {
        res.status(500).json({ success: false, message: err.message });
    }
};
exports.deleteProduct = deleteProduct;

// ==================== 3. BARBERS (KAPSTER) ====================

// GET /api/v1/master/barbers?outletId=...
const getAllBarbers = async (req, res) => {
    try {
        const { outletId = DEFAULT_OUTLET } = req.query;
        const result = await db_1.pool.query(`
            SELECT id, nickname, level, COALESCE(is_active, true) AS is_active 
            FROM barbers 
            WHERE outlet_id = $1 
            ORDER BY nickname ASC
        `, [outletId]);
        res.json({ success: true, data: result.rows });
    }
    catch (err) {
        res.status(500).json({ success: false, message: err.message });
    }
};
exports.getAllBarbers = getAllBarbers;

// POST /api/v1/master/barbers
const createBarber = async (req, res) => {
    try {
        const { nickname, level, outletId = DEFAULT_OUTLET } = req.body;
        if (!nickname || !nickname.trim()) {
            return res.status(400).json({ success: false, message: 'Nama panggilan kapster wajib diisi' });
        }
        const result = await db_1.pool.query(`
            INSERT INTO barbers (tenant_id, outlet_id, nickname, level, is_active)
            VALUES (
                (SELECT tenant_id FROM outlets WHERE id = $1),
                $1, $2, $3, true
            )
            RETURNING id, nickname, level, is_active
        `, [outletId, nickname.trim(), level || 'SENIOR']);
        res.status(201).json({ success: true, message: 'Kapster berhasil didaftarkan', data: result.rows[0] });
    }
    catch (err) {
        res.status(500).json({ success: false, message: err.message });
    }
};
exports.createBarber = createBarber;

// PUT /api/v1/master/barbers/:id
const updateBarber = async (req, res) => {
    try {
        const { id } = req.params;
        const { nickname, level, isActive, is_active } = req.body;
        const finalActive = isActive !== undefined ? isActive : (is_active !== undefined ? is_active : true);

        const result = await db_1.pool.query(`
            UPDATE barbers 
            SET 
                nickname = COALESCE($1, nickname), 
                level = COALESCE($2, level), 
                is_active = $3, 
                updated_at = NOW()
            WHERE id = $4 
            RETURNING *
        `, [nickname ? nickname.trim() : null, level || null, finalActive, id]);

        if (result.rowCount === 0) {
            return res.status(404).json({ success: false, message: 'Kapster tidak ditemukan' });
        }
        res.json({ success: true, message: 'Data kapster berhasil diperbarui', data: result.rows[0] });
    }
    catch (err) {
        res.status(500).json({ success: false, message: err.message });
    }
};
exports.updateBarber = updateBarber;

// DELETE /api/v1/master/barbers/:id
const deleteBarber = async (req, res) => {
    try {
        const { id } = req.params;
        const result = await db_1.pool.query('UPDATE barbers SET is_active = false, updated_at = NOW() WHERE id = $1', [id]);
        if (result.rowCount === 0) {
            return res.status(404).json({ success: false, message: 'Kapster tidak ditemukan' });
        }
        res.json({ success: true, message: 'Kapster berhasil dinonaktifkan' });
    }
    catch (err) {
        res.status(500).json({ success: false, message: err.message });
    }
};
exports.deleteBarber = deleteBarber;