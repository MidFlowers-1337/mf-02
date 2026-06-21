const Router = require('koa-router');
const bcrypt = require('bcryptjs');
const { getDb } = require('./db');
const { signToken, authMiddleware, adminMiddleware } = require('./auth');
const booking = require('./booking');

const router = new Router();

router.post('/api/auth/register', async (ctx) => {
  const { username, password } = ctx.request.body;
  if (!username || !password) {
    ctx.status = 400;
    ctx.body = { error: '用户名和密码不能为空' };
    return;
  }
  if (password.length < 6) {
    ctx.status = 400;
    ctx.body = { error: '密码至少 6 位' };
    return;
  }
  const exists = getDb().prepare('SELECT id FROM users WHERE username = ?').get(username);
  if (exists) {
    ctx.status = 400;
    ctx.body = { error: '用户名已存在' };
    return;
  }
  const hash = bcrypt.hashSync(password, 10);
  const info = getDb().prepare(`
    INSERT INTO users (username, password, role, created_at)
    VALUES (?, ?, 'student', ?)
  `).run(username, hash, Date.now());
  const user = getDb().prepare('SELECT id, username, role FROM users WHERE id = ?').get(info.lastInsertRowid);
  const token = signToken(user);
  ctx.body = { user, token };
});

router.post('/api/auth/login', async (ctx) => {
  const { username, password } = ctx.request.body;
  const user = getDb().prepare('SELECT * FROM users WHERE username = ?').get(username);
  if (!user || !bcrypt.compareSync(password, user.password)) {
    ctx.status = 401;
    ctx.body = { error: '用户名或密码错误' };
    return;
  }
  const safeUser = { id: user.id, username: user.username, role: user.role };
  const token = signToken(safeUser);
  ctx.body = { user: safeUser, token };
});

router.get('/api/auth/me', authMiddleware, async (ctx) => {
  const ban = booking.getBanInfo(ctx.state.user.id);
  ctx.body = {
    user: ctx.state.user,
    ban,
  };
});

router.get('/api/seats', authMiddleware, async (ctx) => {
  const seats = getDb().prepare('SELECT * FROM seats ORDER BY seat_number').all();
  ctx.body = seats;
});

router.get('/api/seats/:id', authMiddleware, async (ctx) => {
  const seat = getDb().prepare('SELECT * FROM seats WHERE id = ?').get(ctx.params.id);
  if (!seat) {
    ctx.status = 404;
    ctx.body = { error: '工位不存在' };
    return;
  }
  ctx.body = seat;
});

router.put('/api/seats/:id', authMiddleware, adminMiddleware, async (ctx) => {
  const { seat_number, zone, has_monitor, by_window, status } = ctx.request.body;
  const seat = getDb().prepare('SELECT * FROM seats WHERE id = ?').get(ctx.params.id);
  if (!seat) {
    ctx.status = 404;
    ctx.body = { error: '工位不存在' };
    return;
  }
  const existing = getDb().prepare('SELECT id FROM seats WHERE seat_number = ? AND id != ?').get(seat_number, ctx.params.id);
  if (existing) {
    ctx.status = 400;
    ctx.body = { error: '工位编号已存在' };
    return;
  }
  getDb().prepare(`
    UPDATE seats SET seat_number = ?, zone = ?, has_monitor = ?, by_window = ?, status = ?
    WHERE id = ?
  `).run(seat_number, zone, has_monitor ? 1 : 0, by_window ? 1 : 0, status, ctx.params.id);
  ctx.body = getDb().prepare('SELECT * FROM seats WHERE id = ?').get(ctx.params.id);
});

router.post('/api/seats', authMiddleware, adminMiddleware, async (ctx) => {
  const { seat_number, zone, has_monitor, by_window, status } = ctx.request.body;
  const existing = getDb().prepare('SELECT id FROM seats WHERE seat_number = ?').get(seat_number);
  if (existing) {
    ctx.status = 400;
    ctx.body = { error: '工位编号已存在' };
    return;
  }
  const info = getDb().prepare(`
    INSERT INTO seats (seat_number, zone, has_monitor, by_window, status, created_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(seat_number, zone, has_monitor ? 1 : 0, by_window ? 1 : 0, status || 'available', Date.now());
  ctx.body = getDb().prepare('SELECT * FROM seats WHERE id = ?').get(info.lastInsertRowid);
});

router.delete('/api/seats/:id', authMiddleware, adminMiddleware, async (ctx) => {
  const seat = getDb().prepare('SELECT * FROM seats WHERE id = ?').get(ctx.params.id);
  if (!seat) {
    ctx.status = 404;
    ctx.body = { error: '工位不存在' };
    return;
  }
  const activeBookings = getDb().prepare(`
    SELECT COUNT(*) as cnt FROM bookings
    WHERE seat_id = ? AND status IN ('reserved', 'checked-in')
  `).get(ctx.params.id);
  if (activeBookings.cnt > 0) {
    ctx.status = 400;
    ctx.body = { error: '该工位有未完成的预约，无法删除' };
    return;
  }
  getDb().prepare('DELETE FROM seats WHERE id = ?').run(ctx.params.id);
  getDb().prepare('DELETE FROM bookings WHERE seat_id = ?').run(ctx.params.id);
  ctx.body = { success: true };
});

router.get('/api/seats/availability/:date/:hour', authMiddleware, async (ctx) => {
  const { date, hour } = ctx.params;
  const hourNum = parseInt(hour, 10);
  const seats = getDb().prepare(`
    SELECT s.*,
      CASE WHEN b.id IS NOT NULL THEN 1 ELSE 0 END as is_booked
    FROM seats s
    LEFT JOIN bookings b ON s.id = b.seat_id
      AND b.booking_date = ?
      AND b.hour_slot = ?
      AND b.status != 'cancelled'
    ORDER BY s.seat_number
  `).all(date, hourNum);
  ctx.body = seats;
});

router.post('/api/bookings', authMiddleware, async (ctx) => {
  const { seatId, bookingDate, hourSlot } = ctx.request.body;
  try {
    const b = booking.createBooking(
      ctx.state.user.id,
      parseInt(seatId, 10),
      bookingDate,
      parseInt(hourSlot, 10)
    );
    ctx.body = b;
  } catch (err) {
    ctx.status = 400;
    ctx.body = { error: err.message };
  }
});

router.get('/api/bookings', authMiddleware, async (ctx) => {
  const bookings = getDb().prepare(`
    SELECT b.*, s.seat_number, s.zone
    FROM bookings b
    JOIN seats s ON b.seat_id = s.id
    WHERE b.user_id = ?
    ORDER BY b.booking_date DESC, b.hour_slot DESC
  `).all(ctx.state.user.id);
  ctx.body = bookings;
});

router.post('/api/bookings/:id/checkin', authMiddleware, async (ctx) => {
  try {
    const b = booking.checkin(parseInt(ctx.params.id, 10), ctx.state.user.id);
    ctx.body = b;
  } catch (err) {
    ctx.status = 400;
    ctx.body = { error: err.message };
  }
});

router.post('/api/bookings/:id/checkout', authMiddleware, async (ctx) => {
  try {
    const b = booking.checkout(parseInt(ctx.params.id, 10), ctx.state.user.id);
    ctx.body = b;
  } catch (err) {
    ctx.status = 400;
    ctx.body = { error: err.message };
  }
});

router.post('/api/bookings/:id/cancel', authMiddleware, async (ctx) => {
  try {
    booking.cancelBooking(parseInt(ctx.params.id, 10), ctx.state.user.id);
    ctx.body = { success: true };
  } catch (err) {
    ctx.status = 400;
    ctx.body = { error: err.message };
  }
});

router.get('/api/admin/bookings', authMiddleware, adminMiddleware, async (ctx) => {
  const { startDate, endDate } = ctx.query;
  let sql = `
    SELECT b.*, u.username, s.seat_number, s.zone
    FROM bookings b
    JOIN users u ON b.user_id = u.id
    JOIN seats s ON b.seat_id = s.id
  `;
  const params = [];
  if (startDate && endDate) {
    sql += ' WHERE b.booking_date >= ? AND b.booking_date <= ?';
    params.push(startDate, endDate);
  }
  sql += ' ORDER BY b.booking_date DESC, b.hour_slot DESC';
  const bookings = getDb().prepare(sql).all(...params);
  ctx.body = bookings;
});

router.get('/api/admin/stats/utilization', authMiddleware, adminMiddleware, async (ctx) => {
  const { startDate, endDate } = ctx.query;
  const today = new Date();
  const defaultStart = new Date(today.getTime() - 30 * 24 * 60 * 60 * 1000);
  const s = startDate || booking.formatDate(defaultStart);
  const e = endDate || booking.formatDate(today);
  ctx.body = booking.getUtilizationStats(s, e);
});

router.get('/api/admin/users', authMiddleware, adminMiddleware, async (ctx) => {
  const users = getDb().prepare('SELECT id, username, role, created_at FROM users ORDER BY created_at DESC').all();
  for (const u of users) {
    u.banInfo = booking.getBanInfo(u.id);
    u.noShowCount = booking.countRecentNoShows(u.id);
  }
  ctx.body = users;
});

router.get('/api/admin/no-shows', authMiddleware, adminMiddleware, async (ctx) => {
  const records = getDb().prepare(`
    SELECT n.*, u.username, s.seat_number
    FROM no_shows n
    JOIN users u ON n.user_id = u.id
    JOIN bookings b ON n.booking_id = b.id
    JOIN seats s ON b.seat_id = s.id
    ORDER BY n.created_at DESC
    LIMIT 100
  `).all();
  ctx.body = records;
});

module.exports = router;
