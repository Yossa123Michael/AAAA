import { Request, Response } from 'express';
import { pool } from '../db';

// POST /api/v1/pos/vouchers/validate
export const validateVoucher = async (req: Request, res: Response) => {
  try {
    const { code, subtotal } = req.body;

    if (!code || subtotal === undefined) {
      return res.status(400).json({ 
        success: false, 
        message: 'Kode voucher dan subtotal belanja wajib diisi' 
      });
    }

    const cleanCode = String(code).trim().toUpperCase();

    // Cari voucher aktif di database
    const query = `
      SELECT * FROM vouchers 
      WHERE UPPER(code) = $1 
        AND is_active = TRUE 
        AND CURRENT_DATE BETWEEN start_date AND end_date
    `;
    const result = await pool.query(query, [cleanCode]);

    if (result.rowCount === 0) {
      return res.status(404).json({
        success: false,
        message: 'Kode voucher tidak ditemukan, sudah kedaluwarsa, atau tidak aktif.'
      });
    }

    const voucher = result.rows[0];

    // 1. Cek Kuota Penggunaan
    if (voucher.usage_limit !== null && voucher.used_count >= voucher.usage_limit) {
      return res.status(400).json({
        success: false,
        message: 'Kuota penggunaan voucher ini sudah habis.'
      });
    }

    // 2. Cek Minimal Belanja
    const orderSubtotal = Number(subtotal);
    if (orderSubtotal < Number(voucher.min_spend)) {
      return res.status(400).json({
        success: false,
        message: `Minimal belanja untuk menggunakan voucher ini adalah Rp ${Number(voucher.min_spend).toLocaleString('id-ID')}`
      });
    }

    // 3. Hitung Potongan Diskon
    let discountAmount = 0;
    if (voucher.discount_type === 'PERCENTAGE') {
      discountAmount = (orderSubtotal * Number(voucher.discount_value)) / 100;
      if (voucher.max_discount && discountAmount > Number(voucher.max_discount)) {
        discountAmount = Number(voucher.max_discount);
      }
    } else {
      discountAmount = Number(voucher.discount_value);
    }

    // Diskon tidak boleh melebihi subtotal
    if (discountAmount > orderSubtotal) {
      discountAmount = orderSubtotal;
    }

    return res.json({
      success: true,
      message: 'Voucher berhasil diterapkan!',
      data: {
        voucherId: voucher.id,
        code: voucher.code,
        discountType: voucher.discount_type,
        discountValue: Number(voucher.discount_value),
        discountAmount: Math.round(discountAmount)
      }
    });
  } catch (error: any) {
    console.error('[VALIDATE_VOUCHER_ERROR]', error);
    return res.status(500).json({ success: false, message: error.message });
  }
};