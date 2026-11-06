import { Router } from 'express';
import {
  getAllServices, createService, updateService, deleteService,
  getAllProducts, createProduct, updateProduct, deleteProduct,
  getAllBarbers, createBarber, updateBarber, deleteBarber, 
  getAllVouchers, createVoucher, toggleVoucherStatus,
} from '../controllers/master.controller';
import {
  checkout,
  getRecentTransactions,
  voidTransaction,
  validateVoucher,
  sendReceiptWhatsApp,
} from '../controllers/pos.controller';

const router = Router();

// Layanan
router.get('/services', getAllServices);
router.post('/services', createService);
router.put('/services/:id', updateService);
router.delete('/services/:id', deleteService);

// Produk Retail
router.get('/products', getAllProducts);
router.post('/products', createProduct);
router.put('/products/:id', updateProduct);
router.delete('/products/:id', deleteProduct);

// Kapster
router.get('/barbers', getAllBarbers);
router.post('/barbers', createBarber);
router.put('/barbers/:id', updateBarber);
router.delete('/barbers/:id', deleteBarber);

// Endpoint Voucher & POS Kasir (Diakses melalui /api/v1/master/...)
router.post('/vouchers/validate', validateVoucher);
router.post('/pos/vouchers/validate', validateVoucher);
router.post('/pos/checkout', checkout);
router.get('/pos/transactions', getRecentTransactions);
router.post('/pos/transactions/:id/void', voidTransaction);
router.post('/pos/send-receipt-wa', sendReceiptWhatsApp);
router.post('/send-receipt-wa', sendReceiptWhatsApp);

router.get('/vouchers', getAllVouchers);
router.post('/vouchers', createVoucher);
router.patch('/vouchers/:id/toggle', toggleVoucherStatus);

export default router;