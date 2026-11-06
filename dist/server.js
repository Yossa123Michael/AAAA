"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = __importDefault(require("express"));
const cors_1 = __importDefault(require("cors"));
const dotenv_1 = __importDefault(require("dotenv"));
const db_1 = require("./db");
const pos_controller_1 = require("./controllers/pos.controller");
const booking_controller_1 = require("./controllers/booking.controller");
const shift_controller_1 = require("./controllers/shift.controller");
const dashboard_controller_1 = require("./controllers/dashboard.controller");
const shift_controller_2 = require("./controllers/shift.controller");
const pos_controller_2 = require("./controllers/pos.controller");
const inventory_controller_1 = require("./controllers/inventory.controller");
const auth_controller_1 = require("./controllers/auth.controller");
const customer_controller_1 = require("./controllers/customer.controller");
const commission_controller_1 = require("./controllers/commission.controller");
const expense_controller_1 = require("./controllers/expense.controller");
const master_controller_1 = require("./controllers/master.controller");
const report_controller_1 = require("./controllers/report.controller");
dotenv_1.default.config();
const app = (0, express_1.default)();
const PORT = process.env.PORT || 5000;
app.use((0, cors_1.default)());
app.use(express_1.default.json());
// Rute Home / Status
app.get('/', (_req, res) => {
    res.json({ status: 'OK', message: 'Barbershop OS API is running 💈' });
});
// Rute Katalog
app.get('/api/v1/test-catalog', async (_req, res) => {
    try {
        const services = await db_1.pool.query('SELECT id, code, name, base_price, default_commission_percent FROM services');
        const products = await db_1.pool.query('SELECT id, sku, name, selling_price, default_commission_percent FROM products');
        const barbers = await db_1.pool.query('SELECT id, nickname, level FROM barbers');
        res.json({
            success: true,
            data: {
                services: services.rows,
                products: products.rows,
                barbers: barbers.rows,
            },
        });
    }
    catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});
// Endpoint Transaksi POS
app.post('/api/v1/pos/checkout', pos_controller_1.checkout);
app.listen(PORT, () => {
    console.log(`[SERVER] Aktif di http://localhost:${PORT}`);
});
// Rute Booking Engine
app.get('/api/v1/bookings/availability', booking_controller_1.getBarberAvailability);
app.post('/api/v1/bookings', booking_controller_1.createBooking);
// Rute Kasir / Shift Closing
app.post('/api/v1/shifts/:shiftId/close', shift_controller_1.closeShift);
// Rute Dashboard Owner & Laporan
app.get('/api/v1/dashboard/summary', dashboard_controller_1.getDashboardSummary);
app.get('/api/v1/bookings/active', booking_controller_1.getActiveBookings);
app.post('/api/v1/shifts/reopen', shift_controller_2.reopenShift);
app.get('/api/v1/pos/transactions', pos_controller_2.getRecentTransactions);
app.post('/api/v1/pos/transactions/:id/void', pos_controller_2.voidTransaction);
app.get('/api/v1/inventory/stocks', inventory_controller_1.getInventoryStocks);
app.post('/api/v1/inventory/restock', inventory_controller_1.restockInventory);
app.post('/api/v1/auth/login', auth_controller_1.login);
app.get('/api/v1/customers/search', customer_controller_1.searchCustomers);
app.post('/api/v1/customers', customer_controller_1.createCustomer);
app.patch('/api/v1/customers/:id/notes', customer_controller_1.updateHaircutNotes);
app.get('/api/v1/commissions/summary', commission_controller_1.getCommissionSummary);
app.get('/api/v1/commissions/details/:barberId', commission_controller_1.getBarberPendingDetails);
app.post('/api/v1/commissions/payout', commission_controller_1.payoutBarberCommission);
app.get('/api/v1/expenses', expense_controller_1.getExpenses);
app.post('/api/v1/expenses', expense_controller_1.createExpense);
app.delete('/api/v1/expenses/:id', expense_controller_1.deleteExpense);
// Master Data Routes
app.get('/api/v1/master/services', master_controller_1.getAllServices);
app.post('/api/v1/master/services', master_controller_1.createService);
app.put('/api/v1/master/services/:id', master_controller_1.updateService);
app.get('/api/v1/master/products', master_controller_1.getAllProducts);
app.post('/api/v1/master/products', master_controller_1.createProduct);
app.put('/api/v1/master/products/:id', master_controller_1.updateProduct);
app.get('/api/v1/master/barbers', master_controller_1.getAllBarbers);
app.post('/api/v1/master/barbers', master_controller_1.createBarber);
app.put('/api/v1/master/barbers/:id', master_controller_1.updateBarber);
// Report Routes
app.get('/api/v1/reports/sales/csv', report_controller_1.exportSalesCSV);
app.get('/api/v1/reports/expenses/csv', report_controller_1.exportExpensesCSV);
app.get('/api/v1/reports/commissions/csv', report_controller_1.exportCommissionsCSV);
