import type { Request, Response } from 'express';
import { pool } from '../db';

// GET /api/v1/expenses?outletId=...
export const getExpenses = async (req: Request, res: Response) => {
  try {
    const { outletId } = req.query;

    const query = `
      SELECT 
        id, 
        outlet_id, 
        shift_id, 
        category, 
        amount, 
        notes, 
        created_by_name, 
        created_at 
      FROM operational_expenses 
      WHERE outlet_id = $1 
      ORDER BY created_at DESC 
      LIMIT 50;
    `;

    const result = await pool.query(query, [outletId]);

    const totalExpense = result.rows.reduce((sum, row) => sum + Number(row.amount), 0);

    res.json({
      success: true,
      data: result.rows,
      summary: { totalExpense, totalRecords: result.rowCount }
    });
  } catch (err: any) {
    res.status(500).json({ success: false, message: err.message });
  }
};

// POST /api/v1/expenses
export const createExpense = async (req: Request, res: Response) => {
  try {
    const { outletId, shiftId, category, amount, notes, createdByName } = req.body;

    if (!outletId || !category || !amount || Number(amount) <= 0) {
      return res.status(400).json({ success: false, message: 'Data pengeluaran tidak lengkap atau nominal tidak valid' });
    }

    const insertQuery = `
      INSERT INTO operational_expenses (
        outlet_id, shift_id, category, amount, notes, created_by_name
      ) VALUES ($1, $2, $3, $4, $5, $6)
      RETURNING id, category, amount, notes, created_by_name, created_at;
    `;

    const result = await pool.query(insertQuery, [
      outletId,
      shiftId || null,
      category,
      Number(amount),
      notes || null,
      createdByName || 'Kasir'
    ]);

    res.status(201).json({
      success: true,
      message: 'Biaya operasional berhasil dicatat!',
      data: result.rows[0]
    });
  } catch (err: any) {
    res.status(500).json({ success: false, message: err.message });
  }
};

// DELETE /api/v1/expenses/:id
export const deleteExpense = async (req: Request, res: Response) => {
  try {
    const { id } = req.params;

    const deleteRes = await pool.query('DELETE FROM operational_expenses WHERE id = $1 RETURNING id', [id]);

    if (deleteRes.rowCount === 0) {
      return res.status(404).json({ success: false, message: 'Catatan pengeluaran tidak ditemukan' });
    }

    res.json({ success: true, message: 'Catatan pengeluaran berhasil dihapus' });
  } catch (err: any) {
    res.status(500).json({ success: false, message: err.message });
  }
};