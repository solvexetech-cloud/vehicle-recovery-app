-- Phase 9 - Support tickets + chat + notifications
CREATE TABLE IF NOT EXISTS support_tickets (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  country_id INTEGER NOT NULL REFERENCES countries(id),
  created_by_user_id INTEGER NOT NULL REFERENCES users(id),
  created_by_role TEXT NOT NULL CHECK (created_by_role IN ('customer','driver','agency')),
  booking_id INTEGER REFERENCES bookings(id),
  category TEXT NOT NULL CHECK (category IN ('payment','conduct','damage','overcharging','late','other')),
  subject TEXT NOT NULL,
  description TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','under_review','waiting_customer','resolved','closed')),
  assigned_to_user_id INTEGER REFERENCES users(id),
  resolution_note TEXT,
  resolved_at TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS ix_tickets_country_status ON support_tickets(country_id, status);
CREATE INDEX IF NOT EXISTS ix_tickets_creator ON support_tickets(created_by_user_id);
CREATE INDEX IF NOT EXISTS ix_tickets_assigned ON support_tickets(assigned_to_user_id);

CREATE TABLE IF NOT EXISTS ticket_messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ticket_id INTEGER NOT NULL REFERENCES support_tickets(id),
  sender_user_id INTEGER NOT NULL REFERENCES users(id),
  sender_role TEXT NOT NULL CHECK (sender_role IN ('customer','driver','agency','country_admin','super_admin')),
  body TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS ix_ticket_msgs_ticket ON ticket_messages(ticket_id, id);

CREATE TABLE IF NOT EXISTS chat_messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  booking_id INTEGER NOT NULL REFERENCES bookings(id),
  sender_user_id INTEGER NOT NULL REFERENCES users(id),
  sender_role TEXT NOT NULL CHECK (sender_role IN ('customer','driver')),
  body TEXT NOT NULL,
  read_at TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS ix_chat_booking ON chat_messages(booking_id, id);
CREATE INDEX IF NOT EXISTS ix_chat_sender ON chat_messages(sender_user_id);

CREATE TABLE IF NOT EXISTS notifications (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id),
  kind TEXT NOT NULL,
  title TEXT NOT NULL,
  body TEXT,
  data_json TEXT,
  read_at TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS ix_notif_user ON notifications(user_id, read_at, id);