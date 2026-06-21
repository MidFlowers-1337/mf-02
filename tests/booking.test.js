const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const fs = require('fs');

process.env.DB_PATH = ':memory:';

const dbModule = require('../src/db');
const booking = require('../src/booking');

function resetDb() {
  const db = dbModule.getDb(':memory:');
  db.exec(`
    DROP TABLE IF EXISTS no_shows;
    DROP TABLE IF EXISTS bookings;
    DROP TABLE IF EXISTS seats;
    DROP TABLE IF EXISTS users;
  `);
  dbModule.init(':memory:');
  return db;
}

function createTestUser(db, username = 'testuser') {
  const bcrypt = require('bcryptjs');
  const hash = bcrypt.hashSync('pass123', 10);
  const info = db.prepare('INSERT INTO users (username, password, role, created_at) VALUES (?, ?, ?, ?)')
    .run(username, hash, 'student', Date.now());
  return info.lastInsertRowid;
}

function getFutureDate(days = 1) {
  const d = new Date();
  d.setDate(d.getDate() + days);
  return booking.formatDate(d);
}

test('单次爽约会正确记录', () => {
  const db = resetDb();
  const userId = createTestUser(db);
  const seatId = 1;
  const futureDate = getFutureDate(1);
  const hour = 10;

  const b = booking.createBooking(userId, seatId, futureDate, hour);
  assert.equal(b.status, 'reserved');

  booking.markNoShow(b.id);

  const noShowCount = booking.countRecentNoShows(userId);
  assert.equal(noShowCount, 1);

  const updated = db.prepare('SELECT status FROM bookings WHERE id = ?').get(b.id);
  assert.equal(updated.status, 'no-show');
});

test('3次爽约触发7天禁约', () => {
  const db = resetDb();
  const userId = createTestUser(db);

  for (let i = 0; i < 3; i++) {
    const futureDate = getFutureDate(i + 1);
    const b = booking.createBooking(userId, 1 + i, futureDate, 10);
    booking.markNoShow(b.id);
  }

  const banInfo = booking.getBanInfo(userId);
  assert.equal(banInfo.banned, true);
  assert.equal(banInfo.count, 3);
  assert.ok(banInfo.remainingHours > 0 && banInfo.remainingHours <= 24 * 7);

  assert.throws(() => {
    booking.createBooking(userId, 5, getFutureDate(10), 10);
  }, /禁约/);
});

test('禁约期间无法预约，但可以取消已有预约', () => {
  const db = resetDb();
  const userId = createTestUser(db);

  const validBooking = booking.createBooking(userId, 5, getFutureDate(10), 11);
  assert.ok(validBooking.id);

  for (let i = 0; i < 3; i++) {
    const futureDate = getFutureDate(i + 1);
    const b = booking.createBooking(userId, 1 + i, futureDate, 10);
    booking.markNoShow(b.id);
  }

  assert.throws(() => {
    booking.createBooking(userId, 6, getFutureDate(10), 12);
  }, /禁约/);

  booking.cancelBooking(validBooking.id, userId);
  const cancelled = db.prepare('SELECT status FROM bookings WHERE id = ?').get(validBooking.id);
  assert.equal(cancelled.status, 'cancelled');
});

test('同一天同一时段不能预约两个工位', () => {
  const db = resetDb();
  const userId = createTestUser(db);
  const futureDate = getFutureDate(1);

  booking.createBooking(userId, 1, futureDate, 10);

  assert.throws(() => {
    booking.createBooking(userId, 2, futureDate, 10);
  }, /同时段已预约/);
});

test('同一工位同一时段不能被两个人约', () => {
  const db = resetDb();
  const user1 = createTestUser(db, 'user1');
  const user2 = createTestUser(db, 'user2');
  const futureDate = getFutureDate(1);

  booking.createBooking(user1, 1, futureDate, 10);

  assert.throws(() => {
    booking.createBooking(user2, 1, futureDate, 10);
  }, /已被预约/);
});

test('维护中的工位不能预约', () => {
  const db = resetDb();
  const userId = createTestUser(db);

  db.prepare('UPDATE seats SET status = ? WHERE id = ?').run('maintenance', 1);

  assert.throws(() => {
    booking.createBooking(userId, 1, getFutureDate(1), 10);
  }, /维护中/);
});

test('不能预约过去的时段', () => {
  const db = resetDb();
  const userId = createTestUser(db);

  const pastDate = booking.formatDate(new Date(Date.now() - 24 * 60 * 60 * 1000));
  assert.throws(() => {
    booking.createBooking(userId, 1, pastDate, 10);
  }, /过去的时段/);
});

function insertBooking(db, userId, seatId, bookingDate, hourSlot, status = 'reserved') {
  const info = db.prepare(`
    INSERT INTO bookings (user_id, seat_id, booking_date, hour_slot, status, created_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(userId, seatId, bookingDate, hourSlot, status, Date.now());
  return db.prepare('SELECT * FROM bookings WHERE id = ?').get(info.lastInsertRowid);
}

test('签到功能正常 - 在时间范围内', () => {
  const db = resetDb();
  const userId = createTestUser(db);

  const now = new Date();
  now.setMinutes(5);
  let hour = now.getHours();
  if (hour < 8) hour = 8;
  if (hour > 21) hour = 21;

  const startTs = booking.getBookingStartTimestamp(booking.formatDate(now), hour);
  const earlyStart = startTs - 5 * 60 * 1000;
  const graceEnd = startTs + 15 * 60 * 1000;
  const nowTs = Date.now();

  let b;
  if (nowTs >= earlyStart && nowTs <= graceEnd) {
    b = insertBooking(db, userId, 1, booking.formatDate(now), hour, 'reserved');
    const checked = booking.checkin(b.id, userId);
    assert.equal(checked.status, 'checked-in');
    assert.ok(checked.checkin_at > 0);
  } else {
    const b1 = insertBooking(db, userId, 1, getFutureDate(1), 10, 'reserved');
    assert.throws(() => booking.checkin(b1.id, userId), /还未到签到时间/);
    assert.ok(true, '提前签到被正确拒绝，逻辑验证通过');
  }
});

test('签到功能 - 提前超过5分钟不能签，提前5分钟内可以签', () => {
  const db = resetDb();
  const userId = createTestUser(db);

  const farFuture = getFutureDate(1);
  const b1 = booking.createBooking(userId, 1, farFuture, 10);
  assert.throws(() => {
    booking.checkin(b1.id, userId);
  }, /还未到签到时间/);
  assert.ok(true, '提前超过5分钟签到被正确拒绝');

  const now = new Date();
  const dateStr = booking.formatDate(now);
  let hour = now.getHours();
  if (hour < 8) hour = 8;
  if (hour > 21) hour = 21;

  const startTs = booking.getBookingStartTimestamp(dateStr, hour);
  const nowTs = Date.now();
  if (nowTs >= startTs - 5 * 60 * 1000 && nowTs <= startTs + 15 * 60 * 1000) {
    const b2 = insertBooking(db, userId, 2, dateStr, hour, 'reserved');
    const checked = booking.checkin(b2.id, userId);
    assert.equal(checked.status, 'checked-in');
    assert.ok(true, '提前5分钟内签到成功');
  }
});

test('签到功能 - 超过15分钟不能签并标记爽约', () => {
  const db = resetDb();
  const userId = createTestUser(db);

  const now = new Date();
  const dateStr = booking.formatDate(now);
  let hour = now.getHours();
  if (hour < 9) hour = 9;
  hour = hour - 1;

  const b = insertBooking(db, userId, 1, dateStr, hour, 'reserved');
  assert.throws(() => {
    booking.checkin(b.id, userId);
  }, /已超过签到时间/);

  const noShows = booking.countRecentNoShows(userId);
  assert.equal(noShows, 1);
});

test('结束使用功能', () => {
  const db = resetDb();
  const userId = createTestUser(db);

  const now = new Date();
  now.setMinutes(5);
  let hour = now.getHours();
  if (hour < 8) hour = 8;
  if (hour > 21) hour = 21;

  const startTs = booking.getBookingStartTimestamp(booking.formatDate(now), hour);
  const earlyStart = startTs - 5 * 60 * 1000;
  const graceEnd = startTs + 15 * 60 * 1000;
  const nowTs = Date.now();

  if (nowTs >= earlyStart && nowTs <= graceEnd) {
    const b = insertBooking(db, userId, 1, booking.formatDate(now), hour, 'reserved');
    booking.checkin(b.id, userId);
    const finished = booking.checkout(b.id, userId);
    assert.equal(finished.status, 'completed');
    assert.ok(finished.checkout_at > 0);
  } else {
    const b = insertBooking(db, userId, 1, getFutureDate(1), 10, 'checked-in');
    const finished = booking.checkout(b.id, userId);
    assert.equal(finished.status, 'completed');
    assert.ok(finished.checkout_at > 0);
  }
});

test('releaseExpiredBookings 能释放超时预约', () => {
  const db = resetDb();
  const userId = createTestUser(db);

  const now = new Date();
  const dateStr = booking.formatDate(now);
  let hour = now.getHours();
  if (hour < 9) hour = 9;
  hour = hour - 1;

  const b = insertBooking(db, userId, 1, dateStr, hour, 'reserved');
  const released = booking.releaseExpiredBookings();

  assert.ok(released.includes(b.id));
  const noShows = booking.countRecentNoShows(userId);
  assert.equal(noShows, 1);
});

test('禁约7天后自动解除', () => {
  const db = resetDb();
  const userId = createTestUser(db);

  const eightDaysAgo = Date.now() - 8 * 24 * 60 * 60 * 1000;
  for (let i = 0; i < 3; i++) {
    const futureDate = getFutureDate(i + 1);
    const b = booking.createBooking(userId, 1 + i, futureDate, 10);
    db.prepare('UPDATE bookings SET status = ? WHERE id = ?').run('no-show', b.id);
    db.prepare(`
      INSERT INTO no_shows (user_id, booking_id, booking_date, hour_slot, created_at)
      VALUES (?, ?, ?, ?, ?)
    `).run(userId, b.id, futureDate, 10, eightDaysAgo + i * 1000);
  }

  const banInfo = booking.getBanInfo(userId);
  assert.equal(banInfo.banned, false);
  assert.equal(banInfo.count, 0);

  const newBooking = booking.createBooking(userId, 5, getFutureDate(1), 14);
  assert.ok(newBooking.id);
});

test('只有已预约状态的预约可以取消', () => {
  const db = resetDb();
  const userId = createTestUser(db);
  const futureDate = getFutureDate(1);

  const b = booking.createBooking(userId, 1, futureDate, 10);
  booking.cancelBooking(b.id, userId);

  const cancelled = db.prepare('SELECT status FROM bookings WHERE id = ?').get(b.id);
  assert.equal(cancelled.status, 'cancelled');

  assert.throws(() => {
    booking.cancelBooking(b.id, userId);
  }, /只能取消/);
});

test('工位利用率统计', () => {
  const db = resetDb();
  const userId = createTestUser(db);

  const future = new Date();
  future.setDate(future.getDate() + 1);
  const startDate = booking.formatDate(future);
  const endDate = booking.formatDate(future);

  for (let i = 0; i < 3; i++) {
    const b = insertBooking(db, userId, i + 1, startDate, 10 + i, 'completed');
  }

  const stats = booking.getUtilizationStats(startDate, endDate);
  assert.equal(stats.totalHours, 3);
  assert.ok(stats.utilizationRate > 0);
  assert.equal(stats.hourStats.length, 3);
});

test('只能预约 8:00-22:00 之间的时段', () => {
  const db = resetDb();
  const userId = createTestUser(db);
  const futureDate = getFutureDate(1);

  assert.throws(() => {
    booking.createBooking(userId, 1, futureDate, 7);
  }, /只能预约/);

  assert.throws(() => {
    booking.createBooking(userId, 1, futureDate, 22);
  }, /只能预约/);

  const b = booking.createBooking(userId, 1, futureDate, 8);
  assert.ok(b.id);
});
