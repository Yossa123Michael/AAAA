import type { Request, Response } from 'express';
import { pool } from '../db';

// GET /api/v1/inventory/stocks?outletId=...
export const getInventoryStocks = async (req: Request, res: Response) => {
  try {
    const { outletId } = req.query;
    const query = `
      SELECT 
        p.id AS product_id,
        p.sku,
        p.name,
        p.selling_price,
        COALESCE(ist.stock_quantity, 0) AS current_stock
      FROM products p
      LEFT JOIN inventory_stocks ist 
        ON p.id = ist.product_id AND ist.outlet_id = $1
      ORDER BY p.name ASC
    `;
    const result = await pool.query(query, [outletId]);
    res.json({ success: true, data: result.rows });
  } catch (err: any) {
    res.status(500).json({ success: false, message: err.message });
  }
};

// POST /api/v1/inventory/restock
export const restockInventory = async (req: Request, res: Response) => {
  const client = await pool.connect();
  try {
    const { outletId, supplierName, notes, items } = req.body;

    if (!outletId || !items || !Array.isArray(items) || items.length === 0) {
      return res.status(400).json({ success: false, message: 'Data restock tidak valid' });
    }

    await client.query('BEGIN');

    for (const item of items) {
      const { productId, quantityAdded, costPrice } = item;
      const qty = Number(quantityAdded);
      const cost = Number(costPrice || 0);

      if (qty <= 0) continue;

      // 1. Update atau insert stok produk di outlet
      let balanceAfter = 0;
      const checkStock = await client.query(
        `SELECT stock_quantity FROM inventory_stocks WHERE outlet_id = $1 AND product_id = $2 FOR UPDATE`,
        [outletId, productId]
      );

      if (checkStock.rowCount && checkStock.rowCount > 0) {
        const updateRes = await client.query(
          `UPDATE inventory_stocks 
           SET stock_quantity = stock_quantity + $1, updated_at = NOW() 
           WHERE outlet_id = $2 AND product_id = $3
           RETURNING stock_quantity`,
          [qty, outletId, productId]
        );
        balanceAfter = updateRes.rows[0].stock_quantity;
      } else {
        const insertRes = await client.query(
          `INSERT INTO inventory_stocks (outlet_id, product_id, stock_quantity, updated_at)
           VALUES ($1, $2, $3, NOW())
           RETURNING stock_quantity`,
          [outletId, productId, qty]
        );
        balanceAfter = insertRes.rows[0].stock_quantity;
      }

      // 2. Catat audit log mutasi stok masuk
      await client.query(
        `INSERT INTO inventory_transactions (
          outlet_id, product_id, reference_type, reference_id,
          quantity_change, balance_after, unit_cost
        ) VALUES ($1, $2, 'PURCHASE_RECEIPT', $3, $4, $5, $6)`,
        [outletId, productId, supplierName || 'SUPPLIER_RESTOCK', qty, balanceAfter, cost]
      );
    }

    await client.query('COMMIT');
    res.status(201).json({ success: true, message: 'Stok barang berhasil diperbarui!' });
  } catch (err: any) {
    await client.query('ROLLBACK');
    res.status(500).json({ success: false, message: err.message });
  } finally {
    client.release();
  }
};