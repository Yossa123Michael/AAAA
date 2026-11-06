import { Router } from 'express';
import {
  getBarberRoster,
  updateWeeklyOff,
  addBarberLeave,
  deleteBarberLeave,
  checkBarberAvailability,
} from '../controllers/roster.controller';

const router = Router();

router.get('/check-availability', checkBarberAvailability);
router.get('/:barberId', getBarberRoster);
router.post('/:barberId/weekly-off', updateWeeklyOff);
router.post('/:barberId/leaves', addBarberLeave);
router.delete('/leaves/:leaveId', deleteBarberLeave);

export default router;