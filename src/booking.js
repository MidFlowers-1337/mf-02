const dbModule = require('./db');
function getDb() {
  return dbModule.getDb();
}

const CHECKIN_GRACE_MINUTES = 15;
const CHECKIN_EARLY_MINUTES = 5;
const NO_SHOW_THRESHOLD = 3;
const BAN_DAYS = 7;

function formatDate(d) {
  const year = d.getFullYear();
  const month = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function getBookingStartTimestamp(bookingDate, hourSlot) {
  const [y, m, d] = bookingDate.split('-').map(Number);
  return new Date(y, m - 1, d, hourSlot, 0, 0).getTime();
}

function countRecentNoShows(userId) {
  const since = Date.now() - BAN_DAYS * 24 * 60 * 60 * 1000;
  const row = getDb().prepare(`
    SELECT COUNT(*) as cnt FROM no_shows
    WHERE user_id = ? AND created_at > ?
  `).get(userId, since);
  return row ? row.cnt : 0;
}

function isUserBanned(userId) {
  const count = countRecentNoShows(userId);
  return count >= NO_SHOW_THRESHOLD;
}

function getBanInfo(userId) {
  const count = countRecentNoShows(userId);
  if (count < NO_SHOW_THRESHOLD) {
    return { banned: false, count };
  }
  const latest = getDb().prepare(`
    SELECT created_at FROM no_shows
    WHERE user_id = ?
    ORDER BY created_at DESC LIMIT 1
  `).get(userId);
  if (!latest) {
    return { banned: false, count };
  }
  const banUntil = latest.created_at + BAN_DAYS * 24 * 60 * 60 * 1000;
  return {
    banned: true,
    count,
    banUntil,
    remainingHours: Math.ceil((banUntil - Date.now()) / (60 * 60 * 1000)),
  };
}

function canBookSeat(seatId, bookingDate, hourSlot, excludeBookingId = null) {
  const seat = getDb().prepare('SELECT * FROM seats WHERE id = ?').get(seatId);
  if (!seat) {
    return { ok: false, error: '工位不存在' };
  }
  if (seat.status !== 'available') {
    return { ok: false, error: '工位维护中，暂不可约' };
  }
  const query = `
    SELECT COUNT(*) as cnt FROM bookings
    WHERE seat_id = ? AND booking_date = ? AND hour_slot = ? AND status != 'cancelled'
  `;
  let row;
  if (excludeBookingId) {
    row = getDb().prepare(query + ' AND id != ?').get(seatId, bookingDate, hourSlot, excludeBookingId);
  } else {
    row = getDb().prepare(query).get(seatId, bookingDate, hourSlot);
  }
  if (row.cnt > 0) {
    return { ok: false, error: '该工位此时段已被预约' };
  }
  return { ok: true };
}

function canUserBookSlot(userId, bookingDate, hourSlot, excludeBookingId = null) {
  const query = `
    SELECT COUNT(*) as cnt FROM bookings
    WHERE user_id = ? AND booking_date = ? AND hour_slot = ? AND status != 'cancelled'
  `;
  let row;
  if (excludeBookingId) {
    row = getDb().prepare(query + ' AND id != ?').get(userId, bookingDate, hourSlot, excludeBookingId);
  } else {
    row = getDb().prepare(query).get(userId, bookingDate, hourSlot);
  }
  if (row.cnt > 0) {
    return { ok: false, error: '您同时段已预约了其他工位' };
  }
  return { ok: true };
}

function isSlotInPast(bookingDate, hourSlot) {
  const start = getBookingStartTimestamp(bookingDate, hourSlot);
  return Date.now() >= start;
}

function createBooking(userId, seatId, bookingDate, hourSlot) {
  const ban = getBanInfo(userId);
  if (ban.banned) {
    throw new Error(`您因爽约${ban.count}次已被禁约，剩余${ban.remainingHours}小时解除`);
  }
  if (isSlotInPast(bookingDate, hourSlot)) {
    throw new Error('不能预约过去的时段');
  }
  if (hourSlot < 8 || hourSlot > 21) {
    throw new Error('只能预约 8:00-22:00 之间的时段');
  }
  const seatCheck = canBookSeat(seatId, bookingDate, hourSlot);
  if (!seatCheck.ok) {
    throw new Error(seatCheck.error);
  }
  const userCheck = canUserBookSlot(userId, bookingDate, hourSlot);
  if (!userCheck.ok) {
    throw new Error(userCheck.error);
  }

  const info = getDb().prepare(`
    INSERT INTO bookings (user_id, seat_id, booking_date, hour_slot, status, created_at)
    VALUES (?, ?, ?, ?, 'reserved', ?)
  `).run(userId, seatId, bookingDate, hourSlot, Date.now());

  return getDb().prepare('SELECT * FROM bookings WHERE id = ?').get(info.lastInsertRowid);
}

function checkin(bookingId, userId) {
  const booking = getDb().prepare('SELECT * FROM bookings WHERE id = ? AND user_id = ?').get(bookingId, userId);
  if (!booking) {
    throw new Error('预约不存在');
  }
  if (booking.status === 'cancelled') {
    throw new Error('预约已取消');
  }
  if (booking.status === 'completed') {
    throw new Error('预约已完成');
  }
  if (booking.status === 'checked-in') {
    throw new Error('已签到');
  }
  if (booking.status === 'no-show') {
    throw new Error('预约已爽约');
  }
  const startTs = getBookingStartTimestamp(booking.booking_date, booking.hour_slot);
  const earlyStart = startTs - CHECKIN_EARLY_MINUTES * 60 * 1000;
  const graceEnd = startTs + CHECKIN_GRACE_MINUTES * 60 * 1000;
  const now = Date.now();
  if (now < earlyStart) {
    const mins = Math.ceil((earlyStart - now) / 60000);
    throw new Error(`还未到签到时间，可提前 ${CHECKIN_EARLY_MINUTES} 分钟签到，还需等待 ${mins} 分钟`);
  }
  if (now > graceEnd) {
    markNoShow(bookingId);
    throw new Error('已超过签到时间（开始后15分钟），预约已自动取消');
  }
  getDb().prepare(`
    UPDATE bookings SET status = 'checked-in', checkin_at = ?
    WHERE id = ?
  `).run(now, bookingId);
  return getDb().prepare('SELECT * FROM bookings WHERE id = ?').get(bookingId);
}

function checkout(bookingId, userId) {
  const booking = getDb().prepare('SELECT * FROM bookings WHERE id = ? AND user_id = ?').get(bookingId, userId);
  if (!booking) {
    throw new Error('预约不存在');
  }
  if (booking.status !== 'checked-in') {
    throw new Error('未签到，无法结束');
  }
  getDb().prepare(`
    UPDATE bookings SET status = 'completed', checkout_at = ?
    WHERE id = ?
  `).run(Date.now(), bookingId);
  return getDb().prepare('SELECT * FROM bookings WHERE id = ?').get(bookingId);
}

function markNoShow(bookingId) {
  const booking = getDb().prepare('SELECT * FROM bookings WHERE id = ?').get(bookingId);
  if (!booking) return;
  if (booking.status !== 'reserved') return;

  getDb().prepare(`
    UPDATE bookings SET status = 'no-show'
    WHERE id = ?
  `).run(bookingId);

  getDb().prepare(`
    INSERT INTO no_shows (user_id, booking_id, booking_date, hour_slot, created_at)
    VALUES (?, ?, ?, ?, ?)
  `).run(booking.user_id, bookingId, booking.booking_date, booking.hour_slot, Date.now());
}

function releaseExpiredBookings() {
  const now = Date.now();
  const graceMs = CHECKIN_GRACE_MINUTES * 60 * 1000;
  const expired = getDb().prepare(`
    SELECT * FROM bookings
    WHERE status = 'reserved'
  `).all().filter(b => {
    const startTs = getBookingStartTimestamp(b.booking_date, b.hour_slot);
    return now > startTs + graceMs;
  });

  const released = [];
  for (const b of expired) {
    markNoShow(b.id);
    released.push(b.id);
  }
  return released;
}

function cancelBooking(bookingId, userId) {
  const booking = getDb().prepare('SELECT * FROM bookings WHERE id = ? AND user_id = ?').get(bookingId, userId);
  if (!booking) {
    throw new Error('预约不存在');
  }
  if (booking.status !== 'reserved') {
    throw new Error('只能取消已预约状态的预约');
  }
  getDb().prepare(`
    UPDATE bookings SET status = 'cancelled'
    WHERE id = ?
  `).run(bookingId);
  return true;
}

function getUtilizationStats(startDate, endDate) {
  const totalHours = getDb().prepare(`
    SELECT COUNT(*) as cnt FROM bookings
    WHERE status IN ('checked-in', 'completed')
      AND booking_date >= ? AND booking_date <= ?
  `).get(startDate, endDate).cnt;

  const totalSeats = getDb().prepare('SELECT COUNT(*) as cnt FROM seats WHERE status = ?').get('available').cnt;
  const days = Math.max(1, Math.ceil((new Date(endDate) - new Date(startDate)) / (24 * 60 * 60 * 1000)) + 1);
  const operatingHours = 14;
  const possibleHours = totalSeats * days * operatingHours;
  const utilizationRate = possibleHours > 0 ? (totalHours / possibleHours * 100).toFixed(1) : '0.0';

  const hourStats = getDb().prepare(`
    SELECT hour_slot, COUNT(*) as cnt FROM bookings
    WHERE status IN ('checked-in', 'completed')
      AND booking_date >= ? AND booking_date <= ?
    GROUP BY hour_slot
    ORDER BY cnt DESC
  `).all(startDate, endDate);

  const zoneStats = getDb().prepare(`
    SELECT s.zone, COUNT(*) as cnt FROM bookings b
    JOIN seats s ON b.seat_id = s.id
    WHERE b.status IN ('checked-in', 'completed')
      AND b.booking_date >= ? AND b.booking_date <= ?
    GROUP BY s.zone
    ORDER BY cnt DESC
  `).all(startDate, endDate);

  return {
    totalHours,
    possibleHours,
    utilizationRate: parseFloat(utilizationRate),
    hourStats,
    zoneStats,
  };
}

module.exports = {
  CHECKIN_GRACE_MINUTES,
  CHECKIN_EARLY_MINUTES,
  NO_SHOW_THRESHOLD,
  BAN_DAYS,
  formatDate,
  getBookingStartTimestamp,
  countRecentNoShows,
  isUserBanned,
  getBanInfo,
  canBookSeat,
  canUserBookSlot,
  isSlotInPast,
  createBooking,
  checkin,
  checkout,
  markNoShow,
  releaseExpiredBookings,
  cancelBooking,
  getUtilizationStats,
};
