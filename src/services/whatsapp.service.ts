// Fungsi normalisasi nomor HP lokal (08xxx -> 628xxx)
export const formatPhoneNumber = (phone: string): string => {
  let cleaned = phone.replace(/\D/g, '');
  if (cleaned.startsWith('0')) {
    cleaned = '62' + cleaned.slice(1);
  } else if (cleaned.startsWith('8')) {
    cleaned = '628' + cleaned.slice(1);
  }
  return cleaned;
};

// Kirim pesan WhatsApp via Fonnte API
export const sendWhatsAppMessage = async (targetPhone: string, message: string) => {
  const token = process.env.WA_GATEWAY_TOKEN;
  const url = process.env.WA_GATEWAY_URL || 'https://api.fonnte.com/send';

  if (!token) {
    console.warn('[WA Gateway] WA_GATEWAY_TOKEN belum diatur di .env');
    return { success: false, message: 'Token tidak ditemukan' };
  }

  const destination = formatPhoneNumber(targetPhone);

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Authorization': token,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        target: destination,
        message: message,
        countryCode: '62',
      }),
    });

    const result = await response.json();
    console.log(`[WA Gateway] Pesan terkirim ke ${destination}:`, result);
    return { success: true, result };
  } catch (error: any) {
    console.error(`[WA Gateway] Gagal mengirim pesan ke ${destination}:`, error.message);
    return { success: false, error: error.message };
  }
};

// Template Tiket Booking Online
export const sendBookingConfirmationWA = async (params: {
  phone: string;
  customerName: string;
  bookingCode: string;
  serviceName: string;
  barberName: string;
  bookingDate: string;
  startTime: string;
  price: number;
}) => {
  const message = 
`💈 *KONFIRMASI RESERVASI - BARBERSHOP OS* 💈

Halo Kak *${params.customerName}*, terima kasih telah melakukan reservasi online!

Berikut rincian jadwal kunjungan Anda:
🏷 *Kode Booking* : *${params.bookingCode}*
✂️ *Treatment*    : ${params.serviceName}
💈 *Kapster*      : ${params.barberName}
📅 *Tanggal*      : ${params.bookingDate}
⏰ *Jam*          : ${params.startTime} WITA
💰 *Estimasi Biaya*: Rp ${Number(params.price).toLocaleString('id-ID')}

📍 *Lokasi*: Cabang Makassar
Mohon hadir 5-10 menit sebelum jadwal dimulai. Tunjukkan kode booking ini saat tiba di kasir. Sampai jumpa! ✨`;

  return sendWhatsAppMessage(params.phone, message);
};

// Template Struk Transaksi Digital (POS)
export const sendDigitalReceiptWA = async (params: {
  phone: string;
  customerName: string;
  invoiceNumber: string;
  items: Array<{ name: string; qty: number; price: number; total: number }>;
  subtotal: number;
  discount: number;
  grandTotal: number;
  paymentMethod: string;
  cashierName: string;
}) => {
  const itemsText = params.items
    .map((item) => `- ${item.name} (${item.qty}x) : Rp ${Number(item.total).toLocaleString('id-ID')}`)
    .join('\n');

  const message =
`🧾 *STRUK PEMBAYARAN DIGITAL - BARBERSHOP OS* 🧾

Terima kasih Kak *${params.customerName}* telah berkunjung hari ini!

No. Invoice : *${params.invoiceNumber}*
Kasir       : ${params.cashierName}
----------------------------------------
*Rincian Pembelian:*
${itemsText}
----------------------------------------
Subtotal     : Rp ${Number(params.subtotal).toLocaleString('id-ID')}
Diskon       : Rp ${Number(params.discount).toLocaleString('id-ID')}
*TOTAL BAYAR : Rp ${Number(params.grandTotal).toLocaleString('id-ID')}*
Metode Bayar : ${params.paymentMethod}

Semoga puas dengan pelayanan kami. Simpan struk ini sebagai bukti pembayaran resmi Anda! ✨`;

  return sendWhatsAppMessage(params.phone, message);
};