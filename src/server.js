const http = require('http');
const { Server } = require('socket.io');
const config = require('./config');
const { createApp } = require('./app');
const { logger } = require('./logger');

const log = logger.child({ component: 'server' });
const { app } = createApp({ logger: log });

// Wrap Express app in HTTP server (required for Socket.io)
const server = http.createServer(app);

// Attach Socket.io
const io = new Server(server, {
  cors: { origin: '*', methods: ['GET', 'POST'] },
  path: '/socket.io'
});

// Make io accessible to route handlers via req.app.get('io') if needed
app.set('io', io);


// ---------- Socket.io Live Tracking ----------
io.on('connection', (socket) => {
  log.info('socket.connected', { id: socket.id });

  socket.on('join_trip', ({ bookingId, role }) => {
    if (!bookingId) return;
    const room = 'trip_' + bookingId;
    socket.join(room);
    log.info('socket.joined', { id: socket.id, room, role });
  });

  socket.on('driver_location', ({ bookingId, lat, lng }) => {
    if (!bookingId) return;
    socket.to('trip_' + bookingId).emit('driver_location_update', { lat, lng });
  });

  socket.on('driver_arrived', ({ bookingId }) => {
    if (!bookingId) return;
    socket.to('trip_' + bookingId).emit('driver_arrived_update');
  });

  socket.on('disconnect', () => {
    log.info('socket.disconnected', { id: socket.id });
  });
});

// Start server
server.listen(config.port, config.host, async () => {
  log.info('server.listening', {
    url: 'http://localhost:' + config.port,
    env: config.nodeEnv,
    version: config.appVersion
  });

  // Auto-seed demo data on first startup
  try {
    const { openDatabase } = require('./db');
    const db = openDatabase(config.dbPath);
    const { ensureDemoData } = require('./seed/demo');
    await ensureDemoData(db);
  } catch (e) {
    log.error('auto_seed_failed', { err: e.message });
  }
});

function shutdown(signal) {
  log.info('server.shutdown', { signal });
  io.close();
  server.close(() => process.exit(0));
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('uncaughtException', (e) => { log.error('uncaught', { err: (e && e.stack) || String(e) }); process.exit(1); });
process.on('unhandledRejection', (e) => { log.error('unhandled_rejection', { err: String(e) }); });


