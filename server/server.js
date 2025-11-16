const express = require('express');
const http = require('http');
const mongoose = require('mongoose');
const dotenv = require('dotenv');
const cors = require('cors');
const { Server } = require('socket.io');
const Message = require('./models/Message');
const { socketAuth } = require('./middleware/clerkAuth');
const fs = require('fs');
const path = require('path');

// Load environment variables
dotenv.config();

// --- MongoDB connection helper (added) ---
const MONGODB_URI = process.env.MONGODB_URI || 'mongodb://localhost:27017/chat-app';

async function connectWithRetry(retries = 5, delayMs = 2000) {
  for (let i = 0; i < retries; i++) {
    try {
      await mongoose.connect(MONGODB_URI, {
        useNewUrlParser: true,
        useUnifiedTopology: true
      });
      console.log('MongoDB connected');
      return;
    } catch (err) {
      console.error(`MongoDB connection attempt ${i + 1} failed:`, err.message);
      if (i < retries - 1) {
        console.log(`Retrying in ${delayMs}ms...`);
        await new Promise((r) => setTimeout(r, delayMs));
      } else {
        console.error('All MongoDB connection attempts failed.');
        // don't exit automatically in dev — allow process to continue so server shows error
        // process.exit(1);
      }
    }
  }
}

connectWithRetry();
// Create Express app and mount middleware/routes
const app = express();
app.use(cors({
  origin: process.env.CLIENT_URL || 'http://localhost:5173',
  methods: ['GET','POST','PUT','DELETE','OPTIONS'],
  credentials: true,
  allowedHeaders: ['Content-Type', 'Authorization']
}));
app.use(express.json());

// simple file logger for tailing logs during development
const LOG_DIR = path.join(__dirname, 'logs');
try { fs.mkdirSync(LOG_DIR, { recursive: true }); } catch (e) {}
const LOG_PATH = path.join(LOG_DIR, 'server.log');
function logToFile(msg) {
  try { fs.appendFileSync(LOG_PATH, `[${new Date().toISOString()}] ${msg}\n`); } catch (e) { /* ignore */ }
}

// mount optional route modules if present
try {
  const roomRoutes = require('./routes/roomRoutes');
  app.use('/api/rooms', roomRoutes);
} catch (err) { console.warn('Room routes not mounted:', err.message); }
try {
  const msgRoutes = require('./routes/messageRoutes');
  app.use('/api/messages', msgRoutes);
} catch (err) { console.warn('Message routes not mounted:', err.message); }

// health and db routes
app.get('/health', (req, res) => res.json({ status: 'ok' }));
app.get('/dbstatus', (req, res) => {
  const state = mongoose.connection.readyState;
  const stateMap = { 0: 'disconnected', 1: 'connected', 2: 'connecting', 3: 'disconnecting' };
  res.json({ state, status: stateMap[state] || 'unknown' });
});

// message pagination endpoint (if Message model is available)
app.get('/messages/paginate', async (req, res) => {
  try {
    const room = req.query.room || 'global';
    const before = parseInt(req.query.before || Date.now(), 10);
    const limit = Math.min(parseInt(req.query.limit || '50', 10), 200);
    if (!Message) return res.status(501).json({ ok: false, error: 'no_message_model' });
    const msgs = await Message.find({ room, timestamp: { $lt: new Date(before) } }).sort({ timestamp: -1 }).limit(limit).lean();
    return res.json({ ok: true, messages: msgs.reverse() });
  } catch (err) {
    console.error('/messages/paginate error', err);
    return res.status(500).json({ ok: false, error: 'server_error' });
  }
});

// Create HTTP server
const server = http.createServer(app);

// Initialize Socket.IO with CORS
const io = new Server(server, {
  cors: {
    origin: process.env.CLIENT_URL || 'http://localhost:5173',
    methods: ['GET', 'POST'],
    credentials: true
  }
});

// expose io to route handlers/controllers via app
app.set('io', io);

// apply socket auth middleware
io.use(socketAuth);

// Store online users (socketId -> username)
// helper to return array of { socketId, username }
const onlineUsers = new Map();
const onlineUsersArray = () => Array.from(onlineUsers.entries()).map(([socketId, username]) => ({ socketId, username }));

// Socket.IO connection handling
io.on('connection', (socket) => {
  console.log('New client connected:', socket.id);
  try { logToFile(`New client connected: ${socket.id}`); } catch (e) {}

  // send current rooms list to the new client
  (async () => {
    try {
      const Room = require('./models/Room');
      const rooms = await Room.find({}).lean();
      // send minimal info (name and id)
      const roomsPayload = rooms.map(r => ({ id: r._id, name: r.name }));
      socket.emit('roomsList', roomsPayload);
      // legacy event name
      socket.emit('rooms', roomsPayload.map(r => ({ name: r.name, id: r.id })));
    } catch (err) {
      socket.emit('roomsList', []);
    }
  })();

  // allow client to request a fresh rooms snapshot
  socket.on('rooms_request', async (_, ack) => {
    try {
      const Room = require('./models/Room');
      const rooms = await Room.find({}).lean();
      const roomsPayload = rooms.map(r => ({ id: r._id, name: r.name }));
      socket.emit('roomsList', roomsPayload);
      socket.emit('rooms', roomsPayload.map(x => ({ name: x.name, id: x.id })));
      if (typeof ack === 'function') ack && ack({ ok: true });
    } catch (err) {
      socket.emit('roomsList', []);
      if (typeof ack === 'function') ack && ack({ ok: false });
    }
  });

  // use clerk-verified username if available
  const autoUsername = socket.clerkUser?.username || socket.clerkUser?.email || null;
  if (autoUsername) {
    onlineUsers.set(socket.id, autoUsername);
    const onlineArr = onlineUsersArray();
    io.emit('onlineUsers', onlineArr);
    // legacy shape expected by some clients
    try {
      const legacyUsers = Array.from(onlineUsers.entries()).map(([sid, name]) => ({ id: sid, name, online: true, socketCount: 1 }));
      io.emit('users', legacyUsers);
    } catch (e) { /* ignore */ }
  }

  // notify others when user joins
  socket.on('join', ({ username }) => {
    const name = socket.clerkUser?.username || username || null;
    if (!name) return;
    onlineUsers.set(socket.id, name);
    const onlineArr = onlineUsersArray();
    io.emit('onlineUsers', onlineArr);
    try { const legacyUsers = Array.from(onlineUsers.entries()).map(([sid, n]) => ({ id: sid, name: n, online: true, socketCount: 1 })); io.emit('users', legacyUsers); } catch (e) {}
    socket.broadcast.emit('notification', { type: 'presence', message: `${name} joined` });

    // auto-join default room and send recent history
    const defaultRoom = 'global';
    socket.join(defaultRoom);
    try { logToFile(`[join] socket:${socket.id} joined room:${defaultRoom} as:${name}`); } catch (e) {}
    (async () => {
      try {
        const limit = 50;
        const msgs = await Message.find({ room: defaultRoom }).sort({ timestamp: -1 }).limit(limit).lean();
        const roomPayload = { room: defaultRoom, messages: msgs.reverse() };
        socket.emit('roomMessages', roomPayload);
        // legacy event name
        socket.emit('room_messages', roomPayload);
      } catch (err) {
        socket.emit('roomMessages', { room: defaultRoom, messages: [] });
      }
    })();
  });

  socket.on('message', async (payload) => {
    try {
      // prefer server-known identity (Clerk username or onlineUsers map) to avoid mismatches
      const fromName = socket.clerkUser?.username || onlineUsers.get(socket.id) || payload.from || 'Anonymous';
      const message = new Message({
        content: payload.content,
        from: fromName,
        room: payload.room || 'global',
        timestamp: new Date()
      });
      await message.save();
      io.to(message.room).emit('message', message);
      try { logToFile(`[message] room:${message.room} from:${message.from} id:${message._id}`); } catch (e) {}
      // legacy: also emit room_messages update for listeners expecting older names
      io.to(message.room).emit('room_message', { room: message.room, message });
    } catch (error) {
      console.error('Error saving message:', error);
    }
  });

  // typing indicator
  socket.on('typing', ({ room, isTyping }) => {
    try {
      const r = room || 'global';
      socket.to(r).emit('typing', { socketId: socket.id, username: onlineUsers.get(socket.id), isTyping });
    } catch (e) { /* ignore */ }
  });

  // mark_read -> read receipts
  socket.on('mark_read', async ({ messageId }, ack) => {
    try {
      if (!messageId) return ack && ack({ ok: false, error: 'messageId required' });
      const m = await Message.findById(messageId);
      if (!m) return ack && ack({ ok: false, error: 'not_found' });
      const reader = onlineUsers.get(socket.id) || socket.clerkUser?.username || `anon-${socket.id.slice(0,6)}`;
      if (!m.readBy) m.readBy = [];
      if (!m.readBy.includes(reader)) {
        m.readBy.push(reader);
        await m.save();
      }
      // notify room and sender
      const room = m.room || 'global';
      io.to(room).emit('message_read', { messageId: m._id, reader });
      if (typeof ack === 'function') ack({ ok: true });
    } catch (err) {
      console.error('mark_read error', err);
      if (typeof ack === 'function') ack({ ok: false, error: 'server_error' });
    }
  });

  // file_message: accept a base64 payload (for demo) and broadcast
  socket.on('file_message', async ({ room, name, data, mime }, ack) => {
    try {
      const msg = new Message({
        content: null,
        from: socket.clerkUser?.username || onlineUsers.get(socket.id) || 'Anonymous',
        room: room || 'global',
        file: { name, data, mime },
        timestamp: new Date(),
      });
      await msg.save();
      io.to(msg.room).emit('file_message', msg);
      if (typeof ack === 'function') ack({ ok: true, id: msg._id });
    } catch (err) {
      console.error('file_message error', err);
      if (typeof ack === 'function') ack({ ok: false, error: 'server_error' });
    }
  });

  // private messages - save + notify recipient with event + notification
  socket.on('privateMessage', async ({ toSocketId, payload }) => {
    try {
      const toUsername = onlineUsers.get(toSocketId) || null;
      const fromName = socket.clerkUser?.username || onlineUsers.get(socket.id) || payload.from || 'Anonymous';
      const message = new Message({
        content: payload.content,
        from: fromName,
        to: toUsername,
        private: true,
        room: null,
        timestamp: new Date()
      });
      await message.save();

      // send message to recipient socket and sender
      io.to(toSocketId).emit('privateMessage', message);
      socket.emit('privateMessage', message);

      // push a notification to recipient
      io.to(toSocketId).emit('notification', {
        type: 'message',
        title: `New message from ${message.from}`,
        body: message.content,
        messageId: message._id,
        private: true
      });
      try { logToFile(`[private_message] from:${message.from} toSocket:${toSocketId} id:${message._id}`); } catch (e) {}
    } catch (error) {
      console.error('Error saving private message:', error);
    }
  });

  // reactions on messages
  socket.on('reaction', async ({ messageId, emoji, by }) => {
    try {
      const msg = await Message.findById(messageId);
      if (!msg) return;

      // find or create reaction entry
      let r = msg.reactions.find(x => x.emoji === emoji);
      if (!r) {
        msg.reactions.push({ emoji, users: [by], count: 1 });
      } else {
        if (r.users.includes(by)) {
          // toggle off
          r.users = r.users.filter(u => u !== by);
          r.count = r.users.length;
          if (r.count === 0) {
            msg.reactions = msg.reactions.filter(x => x.emoji !== emoji);
          }
        } else {
          r.users.push(by);
          r.count = r.users.length;
        }
      }

      await msg.save();

      // Broadcast updated message/reaction to relevant sockets
      if (msg.private) {
        // notify both participants by username
        const targets = [];
        for (const [sid, uname] of onlineUsers.entries()) {
          if (uname === msg.from || uname === msg.to) targets.push(sid);
        }
        targets.forEach(sid => {
          io.to(sid).emit('messageReaction', msg);
          io.to(sid).emit('notification', {
            type: 'reaction',
            title: `${by} reacted`,
            body: `${by} reacted ${emoji} to a message`,
            messageId: msg._id,
            private: true
          });
        });
        // also echo to the emitter
        socket.emit('messageReaction', msg);
      } else {
        const room = msg.room || 'global';
        io.to(room).emit('messageReaction', msg);
        socket.to(room).emit('notification', {
          type: 'reaction',
          title: `${by} reacted`,
          body: `${by} reacted ${emoji}`,
          messageId: msg._id,
          private: false
        });
      }
    } catch (err) {
      console.error('reaction handler error', err);
    }
  });

  // add this block to handle client `joinRoom` emits
  socket.on('joinRoom', async ({ room }, ack) => {
    try {
      if (!room) return ack && ack({ ok: false, error: 'room required' });
      // ensure the room exists before joining
      try {
        const Room = require('./models/Room');
        const exists = await Room.findOne({ name: room }).lean();
        if (!exists) return ack && ack({ ok: false, error: 'room_not_found' });
      } catch (e) {
        // if Room model isn't present, allow join (development fallback)
      }
      // join the socket to the requested room
      socket.join(room);
      console.log(`Socket ${socket.id} joined room: ${room}`);

      // emit updated online users (optional)
      io.emit('onlineUsers', onlineUsersArray());

      // send recent room history to the joining socket
      try {
        const limit = 50;
        const msgs = await Message.find({ room }).sort({ timestamp: -1 }).limit(limit).lean();
        socket.emit('roomMessages', { room, messages: msgs.reverse() });
      } catch (err) {
        console.warn('Failed to load room messages for', room, err.message);
        socket.emit('roomMessages', { room, messages: [] });
      }
    } catch (err) {
      console.error('joinRoom handler error', err);
    }
  });

  // legacy snake_case alias for older clients
  socket.on('join_room', async ({ room }, ack) => {
    try {
      // reuse same semantics as joinRoom
      if (!room) return ack && ack({ ok: false, error: 'room required' });
      try {
        const Room = require('./models/Room');
        const exists = await Room.findOne({ name: room }).lean();
        if (!exists) return ack && ack({ ok: false, error: 'room_not_found' });
      } catch (e) {
        // allow join when Room model not present
      }
      socket.join(room);
      console.log(`Socket ${socket.id} joined room: ${room}`);
      io.emit('onlineUsers', onlineUsersArray());
      try {
        const limit = 50;
        const msgs = await Message.find({ room }).sort({ timestamp: -1 }).limit(limit).lean();
        socket.emit('roomMessages', { room, messages: msgs.reverse() });
      } catch (err) {
        socket.emit('roomMessages', { room, messages: [] });
      }
    } catch (err) {
      console.error('join_room alias error', err);
    }
  });

  // leaveRoom handler
  socket.on('leaveRoom', ({ room }, ack) => {
    try {
      if (!room) return ack && ack({ ok: false, error: 'room required' });
      socket.leave(room);
      // emit updated room users to room
      try {
        const socketsInRoom = io.sockets.adapter.rooms.get(room) || new Set();
        const roomUsers = Array.from(socketsInRoom).map((sid) => onlineUsers.get(sid)).filter(Boolean).map(n => ({ id: sid, name: n }));
        io.to(room).emit('roomUsers', { room, users: roomUsers });
      } catch (e) {}
      if (typeof ack === 'function') ack({ ok: true });
    } catch (err) {
      console.error('leaveRoom error', err);
      if (typeof ack === 'function') ack({ ok: false, error: 'server_error' });
    }
  });

  // legacy alias
  socket.on('leave_room', ({ room }, ack) => {
    try {
      if (!room) return ack && ack({ ok: false, error: 'room required' });
      socket.leave(room);
      try {
        const socketsInRoom = io.sockets.adapter.rooms.get(room) || new Set();
        const roomUsers = Array.from(socketsInRoom).map((sid) => onlineUsers.get(sid)).filter(Boolean).map(n => ({ id: sid, name: n }));
        io.to(room).emit('roomUsers', { room, users: roomUsers });
      } catch (e) {}
      if (typeof ack === 'function') ack({ ok: true });
    } catch (err) {
      console.error('leave_room alias error', err);
      if (typeof ack === 'function') ack({ ok: false, error: 'server_error' });
    }
  });

  // createRoom via socket
  socket.on('createRoom', async ({ name }, ack) => {
    try {
      if (!name) return ack && ack({ ok: false, error: 'name required' });
      const Room = require('./models/Room');
      const exists = await Room.findOne({ name }).lean();
      if (exists) return ack && ack({ ok: false, error: 'room exists' });
      const r = new Room({ name, createdBy: socket.clerkUser?.id || socket.id, createdAt: new Date() });
      await r.save();
      // Acknowledge success to creator immediately so client doesn't get server_error
      try { if (typeof ack === 'function') ack({ ok: true, room: { id: r._id, name: r.name } }); } catch (e) {}
      // broadcast updated rooms list (non-fatal: errors here shouldn't change the ack already sent)
      (async () => {
        try {
          const rooms = await Room.find({}).lean();
          const roomsPayload = rooms.map(rr => ({ id: rr._id, name: rr.name }));
          io.emit('roomsList', roomsPayload);
          io.emit('rooms', roomsPayload.map(x => ({ name: x.name, id: x.id })));
        } catch (e) {
          console.warn('createRoom: failed to broadcast rooms list', e && e.message);
        }
      })();
    } catch (err) {
      console.error('createRoom error', err);
      try { if (typeof ack === 'function') ack({ ok: false, error: 'server_error' }); } catch (e) {}
    }
  });

  // legacy alias for create_room
  socket.on('create_room', async ({ name }, ack) => {
    try {
      if (!name) return ack && ack({ ok: false, error: 'name required' });
      const Room = require('./models/Room');
      const exists = await Room.findOne({ name }).lean();
      if (exists) return ack && ack({ ok: false, error: 'room exists' });
      const r = new Room({ name, createdBy: socket.clerkUser?.id || socket.id, createdAt: new Date() });
      await r.save();
      try { if (typeof ack === 'function') ack({ ok: true, room: { id: r._id, name: r.name } }); } catch (e) {}
      (async () => {
        try {
          const rooms = await Room.find({}).lean();
          const roomsPayload = rooms.map(rr => ({ id: rr._id, name: rr.name }));
          io.emit('roomsList', roomsPayload);
          io.emit('rooms', roomsPayload.map(x => ({ name: x.name, id: x.id })));
        } catch (e) { console.warn('create_room: failed to broadcast rooms list', e && e.message); }
      })();
    } catch (err) {
      console.error('create_room alias error', err);
      try { if (typeof ack === 'function') ack({ ok: false, error: 'server_error' }); } catch (e) {}
    }
  });

  // clearRoom: delete all messages in a room
  socket.on('clearRoom', async ({ room }, ack) => {
    try {
      if (!room) return ack && ack({ ok: false, error: 'room required' });
      const res = await Message.deleteMany({ room });
      io.to(room).emit('roomCleared', { room });
      if (typeof ack === 'function') ack({ ok: true, deleted: res.deletedCount || 0 });
    } catch (err) {
      console.error('clearRoom error', err);
      if (typeof ack === 'function') ack({ ok: false, error: 'server_error' });
    }
  });

  // deleteRoom: remove room document and its messages
  socket.on('deleteRoom', async ({ room }, ack) => {
    try {
      if (!room) return ack && ack({ ok: false, error: 'room required' });
      const Room = require('./models/Room');
      const rm = await Room.findOneAndDelete({ name: room });
      await Message.deleteMany({ room });
      // notify clients
      io.emit('roomDeleted', { room });
      // update rooms list
      try { const rooms = await Room.find({}).lean(); const roomsPayload = rooms.map(r => ({ id: r._id, name: r.name })); io.emit('roomsList', roomsPayload); io.emit('rooms', roomsPayload.map(x=>({ name: x.name, id: x.id }))); } catch(e){}
      if (typeof ack === 'function') ack({ ok: true });
    } catch (err) {
      console.error('deleteRoom error', err);
      if (typeof ack === 'function') ack({ ok: false, error: 'server_error' });
    }
  });

  // deleteMessage: remove a message by id (room or private)
  socket.on('deleteMessage', async ({ messageId }, ack) => {
    try {
      if (!messageId) return ack && ack({ ok: false, error: 'messageId required' });
      const msg = await Message.findById(messageId);
      if (!msg) return ack && ack({ ok: false, error: 'not_found' });

      const requester = socket.clerkUser?.username || onlineUsers.get(socket.id) || null;
      const allowAdmin = process.env.ALLOW_ADMIN_DELETE === 'true';
      if (msg.from !== requester && !allowAdmin) {
        return ack && ack({ ok: false, error: 'not_authorized' });
      }

      await Message.findByIdAndDelete(messageId);
      if (msg.private) {
        // notify both parties (try to find sockets by name)
        const targets = [];
        for (const [sid, uname] of onlineUsers.entries()) {
          if (uname === msg.from || uname === msg.to) targets.push(sid);
        }
        targets.forEach(sid => io.to(sid).emit('messageDeleted', { messageId }));
      } else {
        const room = msg.room || 'global';
        io.to(room).emit('messageDeleted', { messageId });
      }
      if (typeof ack === 'function') ack({ ok: true });
    } catch (err) {
      console.error('deleteMessage error', err);
      if (typeof ack === 'function') ack({ ok: false, error: 'server_error' });
    }
  });

  // existing leaveRoom handler should already exist:
  // socket.on('leaveRoom', ({ room }) => { socket.leave(room); ... });
  // ...existing handlers...

  // presence disconnect notification
  socket.on('disconnect', () => {
    const username = onlineUsers.get(socket.id);
    onlineUsers.delete(socket.id);
    io.emit('onlineUsers', onlineUsersArray());
    socket.broadcast.emit('notification', { type: 'presence', message: `${username || 'A user'} left` });
    console.log(`${username || 'A user'} disconnected`);
  });
});

// graceful shutdown for mongoose
process.on('SIGINT', async () => {
  console.log('SIGINT received: closing MongoDB connection');
  try {
    await mongoose.disconnect();
    console.log('MongoDB disconnected');
  } catch (err) {
    console.error('Error disconnecting MongoDB:', err);
  }
  process.exit(0);
});

// Start server with resilient port handling: if the desired port is in use,
// try subsequent ports up to a limit. This avoids repeated EADDRINUSE crashes
// during development when nodemon restarts or a previous process lingers.
const DEFAULT_PORT = parseInt(process.env.PORT || '5000', 10);
const MAX_PORT_TRIES = parseInt(process.env.MAX_PORT_TRIES || '10', 10);

function startServer(port, attemptsLeft) {
  port = parseInt(port, 10);
  server.once('error', (err) => {
    if (err && err.code === 'EADDRINUSE') {
      console.warn(`Port ${port} in use, ${attemptsLeft - 1} attempts left; trying ${port + 1}...`);
      if (attemptsLeft > 1) {
        // remove previous listener and try next port
        server.removeAllListeners('error');
        setTimeout(() => startServer(port + 1, attemptsLeft - 1), 250);
      } else {
        console.error(`All port attempts failed up to ${port}. Exiting.`);
        process.exit(1);
      }
    } else {
      console.error('Server error during listen:', err);
      process.exit(1);
    }
  });

  server.listen(port, () => {
    console.log(`Server running on port ${port}`);
    // remove the one-time error listener to avoid memory leaks
    server.removeAllListeners('error');
  });
}

startServer(DEFAULT_PORT, MAX_PORT_TRIES);