const Database = require('better-sqlite3');
const path = require('path');
const bcrypt = require('bcryptjs');
const fs = require('fs');

let db;

function getDb(customPath) {
  if (db) return db;
  let dbPath = customPath || process.env.DB_PATH;
  if (!dbPath) {
    const dataDir = path.join(__dirname, '..', 'data');
    if (!fs.existsSync(dataDir)) {
      fs.mkdirSync(dataDir, { recursive: true });
    }
    dbPath = path.join(dataDir, 'booking.db');
  }
  db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  return db;
}

function init(customPath) {
  db = getDb(customPath);
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT UNIQUE NOT NULL,
      password TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'student',
      created_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS seats (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      seat_number TEXT UNIQUE NOT NULL,
      zone TEXT NOT NULL,
      has_monitor INTEGER NOT NULL DEFAULT 0,
      by_window INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'available',
      created_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS bookings (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      seat_id INTEGER NOT NULL,
      booking_date TEXT NOT NULL,
      hour_slot INTEGER NOT NULL,
      status TEXT NOT NULL DEFAULT 'reserved',
      checkin_at INTEGER,
      checkout_at INTEGER,
      created_at INTEGER NOT NULL,
      FOREIGN KEY (user_id) REFERENCES users(id),
      FOREIGN KEY (seat_id) REFERENCES seats(id),
      UNIQUE(seat_id, booking_date, hour_slot)
    );

    CREATE TABLE IF NOT EXISTS no_shows (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      booking_id INTEGER NOT NULL,
      booking_date TEXT NOT NULL,
      hour_slot INTEGER NOT NULL,
      created_at INTEGER NOT NULL,
      FOREIGN KEY (user_id) REFERENCES users(id),
      FOREIGN KEY (booking_id) REFERENCES bookings(id)
    );

    CREATE INDEX IF NOT EXISTS idx_bookings_user ON bookings(user_id);
    CREATE INDEX IF NOT EXISTS idx_bookings_seat ON bookings(seat_id);
    CREATE INDEX IF NOT EXISTS idx_bookings_date ON bookings(booking_date);
    CREATE INDEX IF NOT EXISTS idx_no_shows_user ON no_shows(user_id);
    CREATE INDEX IF NOT EXISTS idx_no_shows_date ON no_shows(created_at);
  `);

  const adminCount = db.prepare('SELECT COUNT(*) as cnt FROM users WHERE role = ?').get('admin').cnt;
  if (adminCount === 0) {
    const hash = bcrypt.hashSync('admin123', 10);
    db.prepare('INSERT INTO users (username, password, role, created_at) VALUES (?, ?, ?, ?)')
      .run('admin', hash, 'admin', Date.now());
  }

  const seatCount = db.prepare('SELECT COUNT(*) as cnt FROM seats').get().cnt;
  if (seatCount === 0) {
    const seats = [
      { seat_number: 'A01', zone: 'A区', has_monitor: 1, by_window: 0 },
      { seat_number: 'A02', zone: 'A区', has_monitor: 1, by_window: 1 },
      { seat_number: 'A03', zone: 'A区', has_monitor: 0, by_window: 0 },
      { seat_number: 'B01', zone: 'B区', has_monitor: 1, by_window: 1 },
      { seat_number: 'B02', zone: 'B区', has_monitor: 0, by_window: 1 },
      { seat_number: 'B03', zone: 'B区', has_monitor: 1, by_window: 0 },
      { seat_number: 'C01', zone: 'C区', has_monitor: 1, by_window: 0 },
      { seat_number: 'C02', zone: 'C区', has_monitor: 0, by_window: 0 },
    ];
    const insert = db.prepare('INSERT INTO seats (seat_number, zone, has_monitor, by_window, status, created_at) VALUES (?, ?, ?, ?, ?, ?)');
    const now = Date.now();
    for (const s of seats) {
      insert.run(s.seat_number, s.zone, s.has_monitor, s.by_window, 'available', now);
    }
  }
}

module.exports = { db, init, getDb };
