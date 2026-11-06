import { Router } from 'express';
import { exportSalesCsv, exportCommissionsCsv } from '../controllers/reports.controller';

const router = Router();

router.get('/sales/csv', exportSalesCsv);
router.get('/commissions/csv', exportCommissionsCsv);

export default router;