import type { Request, Response } from 'express';
import { pool } from '../db';

const DEFAULT_OUTLET = '22222222-2222-2222-2222-222222222222';

// 1. Ekspor Laporan Penjualan & Transaksi Kasir
export const exportSalesCsv = async (req: Request, res: Response) => {
  try {
    const { startDate, endDate, outletId = DEFAULT_OUTLET } = req.query;

    const start = startDate ? `${startDate} 00:00:00` : '1970-01-01 00:00:00';
    const end = endDate ? `${endDate} 23:59:59` : '2099-12-31 23:59:59';

    const query = `
      SELECT 
        t.invoice_number,
        TO_CHAR(t.created_at, 'YYYY-MM-DD HH24:MI:SS') AS transaction_time,
        COALESCE(c.full_name, 'Pelanggan Umum') AS customer_name,
        COALESCE(c.phone, '-') AS customer_phone,
        COALESCE(tp.payment_method, 'CASH') AS payment_method,
        COALESCE(t.subtotal, t.grand_total) AS subtotal,
        COALESCE(t.discount_total, 0) AS discount_total,
        COALESCE(v.code, '-') AS voucher_code,
        COALESCE(t.discount_reason, '-') AS discount_reason,
        t.grand_total,
        t.status
      FROM transactions t
      LEFT JOIN customers c ON t.customer_id = c.id
      LEFT JOIN vouchers v ON t.voucher_id = v.id 
      WHERE t.outlet_id = $1
        AND t.created_at BETWEEN $2 AND $3
      ORDER BY t.created_at DESC
    `;

    const result = await pool.query(query, [outletId, start, end]);

    // Format CSV dengan BOM (\uFEFF) untuk kompatibilitas penuh Excel
    let csv = '\uFEFF';
    csv += 'No Invoice,Waktu Transaksi,Nama Pelanggan,No HP,Metode Bayar,Subtotal (Rp),Total Diskon (Rp),Kode Voucher,Alasan Diskon (Audit),Total Bayar (Rp),Status\n';

    result.rows.forEach((r) => {
      csv += `"${r.invoice_number}","${r.transaction_time}","${r.customer_name}","${r.customer_phone}","${r.payment_method}",${Number(r.subtotal)},${Number(r.discount_total)},"${r.voucher_code}","${r.discount_reason}",${Number(r.grand_total)},"${r.status}"\n`;
    });

    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader(
      'Content-Disposition',
      `attachment; filename=Laporan_Penjualan_${startDate || 'all'}_sd_${endDate || 'all'}.csv`
    );
    return res.status(200).send(csv);
  } catch (err: any) {
    return res.status(500).json({ success: false, message: err.message });
  }
};

// 2. Ekspor Rekap Komisi & Payroll Kapster
export const exportCommissionsCsv = async (req: Request, res: Response) => {
  try {
    const { startDate, endDate, outletId = DEFAULT_OUTLET } = req.query;

    const start = startDate ? `${startDate} 00:00:00` : '1970-01-01 00:00:00';
    const end = endDate ? `${endDate} 23:59:59` : '2099-12-31 23:59:59';

    const query = `
      SELECT 
        b.nickname AS barber_name,
        b.level AS barber_level,
        COUNT(ti.id) AS total_jobs,
        COALESCE(SUM(ti.quantity * ti.unit_price), 0) AS total_gross_sales,
        COALESCE(SUM(ti.commission_amount), 0) AS total_commission
      FROM barbers b
      LEFT JOIN transaction_items ti ON b.id = ti.barber_id
      LEFT JOIN transactions t ON ti.transaction_id = t.id 
        AND t.status = 'PAID' 
        AND t.created_at BETWEEN $2 AND $3
      WHERE b.outlet_id = $1 AND b.is_active = true
      GROUP BY b.id, b.nickname, b.level
      ORDER BY total_commission DESC
    `;

    const result = await pool.query(query, [outletId, start, end]);

    let csv = '\uFEFF';
    csv += 'Nama Kapster,Level Skill,Total Pengerjaan,Omzet Treatment/Produk (Rp),Hak Komisi (Rp)\n';

    result.rows.forEach((r) => {
      csv += `"${r.barber_name}","${r.barber_level}",${r.total_jobs},${Number(r.total_gross_sales)},${Number(r.total_commission)}\n`;
    });

    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader(
      'Content-Disposition',
      `attachment; filename=Rekap_Komisi_Kapster_${startDate || 'all'}_sd_${endDate || 'all'}.csv`
    );
    return res.status(200).send(csv);
  } catch (err: any) {
    return res.status(500).json({ success: false, message: err.message });
  }
};