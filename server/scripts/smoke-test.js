const { io } = require('socket.io-client');

const SERVER = process.env.SERVER_URL || 'http://localhost:5000';

function wait(ms) { return new Promise(r => setTimeout(r, ms)); }

async function run() {
  console.log('Smoke test connecting to', SERVER);

  const a = io(SERVER, { reconnectionDelayMax: 1000 });
  const b = io(SERVER, { reconnectionDelayMax: 1000 });

  const state = { msgId: null, aId: null, bId: null };

  a.on('connect', () => { console.log('A connected', a.id); state.aId = a.id; a.emit('join', { username: 'Alice' }); });
  b.on('connect', () => { console.log('B connected', b.id); state.bId = b.id; b.emit('join', { username: 'Bob' }); });

  a.on('onlineUsers', (list) => { console.log('A onlineUsers', list); });
  b.on('onlineUsers', (list) => { console.log('B onlineUsers', list); });

  // ambient listeners
  a.on('roomsList', (rooms) => { console.log('A roomsList', rooms); });
  b.on('roomsList', (rooms) => { console.log('B roomsList', rooms); });

  b.on('roomMessages', (payload) => { console.log('B roomMessages', payload.room, payload.messages.length); });

  a.on('message', (m) => { console.log('A got message', m._id || m.id || m); });
  b.on('message', (m) => {
    console.log('B got message', m._id || m.id || m);
    state.msgId = m._id || m.id;
  });
  a.on('typing', (t) => { console.log('A typing event', t); });
  b.on('typing', (t) => { console.log('B typing event', t); });
  a.on('message_read', (d) => { console.log('A message_read', d); });
  b.on('message_read', (d) => { console.log('B message_read', d); });
  a.on('file_message', (m) => { console.log('A file_message', m.id || m._id); });
  b.on('file_message', (m) => { console.log('B file_message', m.id || m._id); });

  a.on('messageReaction', (m) => { console.log('A messageReaction', m._id); });
  b.on('messageReaction', (m) => { console.log('B messageReaction', m._id); });

  a.on('messageDeleted', (data) => { console.log('A messageDeleted', data); });
  b.on('messageDeleted', (data) => { console.log('B messageDeleted', data); });

  // wait for connections
  await wait(1200);

  console.log('A creating room testroom');
  a.emit('createRoom', { name: 'testroom' }, (ack) => { console.log('createRoom ack A', ack); });
  await wait(500);

  console.log('B joining room testroom');
  b.emit('joinRoom', { room: 'testroom' }, (ack) => { console.log('joinRoom ack B', ack); });
  await wait(500);

  console.log('A sending message to testroom');
  a.emit('message', { content: 'Hello from Alice', from: 'Alice', room: 'testroom' });

  // wait for message to be delivered
  await wait(800);
  if (!state.msgId) console.warn('No message id captured yet');

  console.log('B reacting to message with ❤️');
  if (state.msgId) b.emit('reaction', { messageId: state.msgId, emoji: '❤️', by: 'Bob' });

  await wait(500);

  console.log('B attempting to delete the message (should be not_authorized)');
  b.emit('deleteMessage', { messageId: state.msgId }, (ack) => { console.log('B deleteMessage ack', ack); });

  await wait(500);

  console.log('A deleting own message');
  a.emit('deleteMessage', { messageId: state.msgId }, (ack) => { console.log('A deleteMessage ack', ack); });

  await wait(800);

  console.log('Testing private message from A -> B');
  // find B socket id from server onlineUsers (best-effort via emitted lists)
  a.emit('privateMessage', { toSocketId: state.bId, payload: { content: 'Hey Bob, private', from: 'Alice' } });

  await wait(800);

  // typing indicator simulation
  console.log('A typing true');
  a.emit('typing', { room: 'testroom', isTyping: true });
  await wait(300);
  console.log('A typing false');
  a.emit('typing', { room: 'testroom', isTyping: false });
  await wait(300);

  // read receipt: B marks message as read
  if (state.msgId) {
    console.log('B marking read for', state.msgId);
    b.emit('mark_read', { messageId: state.msgId }, (ack) => { console.log('mark_read ack', ack); });
  }
  await wait(400);

  // pagination via HTTP fetch
  try {
    console.log('Pagination request for testroom');
    const res = await fetch(`${SERVER}/messages/paginate?room=testroom&limit=10`);
    const json = await res.json();
    console.log('Pagination result count', json.messages?.length || 0);
  } catch (e) { console.warn('Pagination fetch failed', e.message); }
  await wait(400);

  // file_message (base64 demo)
  const fakeBase64 = Buffer.from('hello file').toString('base64');
  console.log('A sending file_message');
  a.emit('file_message', { room: 'testroom', name: 'hello.txt', data: fakeBase64, mime: 'text/plain' }, (ack) => { console.log('file_message ack', ack); });
  await wait(600);

  // reconnection: disconnect B then reconnect
  console.log('Simulating B disconnect');
  b.disconnect();
  await wait(500);
  console.log('Reconnecting B');
  const b2 = io(SERVER, { reconnectionDelayMax: 1000 });
  b2.on('connect', () => { console.log('B2 connected', b2.id); b2.emit('join', { username: 'Bob' }); });
  b2.on('roomsList', (rooms) => console.log('B2 roomsList', rooms));
  await wait(800);

  console.log('Smoke test done — disconnecting');
  a.disconnect(); b.disconnect();
  process.exit(0);
}

run().catch(e => { console.error('Smoke test error', e); process.exit(1); });
