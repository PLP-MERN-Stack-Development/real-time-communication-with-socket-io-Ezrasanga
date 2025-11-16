import { useEffect, useRef, useState } from 'react';
import { io } from 'socket.io-client';


export default function useSocket({ url, username }) {
const socketRef = useRef();
const [connected, setConnected] = useState(false);
const [messages, setMessages] = useState([]);
const [onlineUsers, setOnlineUsers] = useState([]);
const [typing, setTyping] = useState([]);


useEffect(() => {
  const socketUrl = url || process.env.REACT_APP_SOCKET_URL || 'http://localhost:5000';
  console.log('useSocket connecting to:', socketUrl); // <-- confirm URL in browser console

  socketRef.current = io(
    socketUrl,
    { 
      autoConnect: true,
      withCredentials: true,
      // try polling first so failures to upgrade don't immediately blow up
      transports: ['polling', 'websocket']
    }
  );

  console.log('socket client opts:', socketRef.current.io?.opts);


socketRef.current.on('connect', () => setConnected(true));


  // server emits canonical names: 'message', 'private_message', 'users', 'users_count', etc.
  socketRef.current.on('message', (m) => setMessages((s) => [...s, m]));
  socketRef.current.on('private_message', (m) => setMessages((s) => [...s, m]));

  socketRef.current.on('users', (list) => setOnlineUsers(list));
  socketRef.current.on('users_count', (count) => {
    // optionally use users_count for badges; for now keep onlineUsers list authoritative
    // console.info('users_count', count);
  });

  // typing events: keep a short-lived list of typing users
  socketRef.current.on('typing', (t) => {
    setTyping((prev) => {
      // dedupe by userId + room
      const key = `${t.userId}:${t.room || 'global'}`;
      const exists = prev.find((p) => `${p.userId}:${p.room || 'global'}` === key);
      if (exists) return prev.map((p) => ((`${p.userId}:${p.room || 'global'}` === key) ? t : p));
      return [...prev, t];
    });
    // remove typing state after a timeout (e.g., 3s)
    setTimeout(() => {
      setTyping((prev) => prev.filter((p) => `${p.userId}:${p.room || 'global'}` !== `${t.userId}:${t.room || 'global'}`));
    }, 3000);
  });

  // read receipts
  socketRef.current.on('message_read', (r) => {
    setMessages((prev) => prev.map((m) => (m.id === r.messageId ? { ...m, readBy: [...(m.readBy || []), r.userId] } : m)));
  });

  // reactions
  socketRef.current.on('reaction', (data) => {
    setMessages((prev) => prev.map((m) => (m.id === data.messageId ? { ...m, reactions: { ...(m.reactions || {}), [data.reaction]: data.count } } : m)));
  });

  // file messages
  socketRef.current.on('file_message', (m) => setMessages((s) => [...s, m]));


// join as user
if (username) {
  socketRef.current.emit('join', { username });
}

const root = document.getElementById('root') || document.body;
const tailwindClasses = [
    'min-h-screen',
    'bg-gray-50',
    'text-gray-800',
    'antialiased',
    'p-4',
    'container',
    'mx-auto'
];
root.classList.add(...tailwindClasses);

socketRef.current.on('disconnect', () => {
    root.classList.remove(...tailwindClasses);
});
return () => {
socketRef.current.disconnect();
};
}, [url, username]);


const sendMessage = (payload) => socketRef.current.emit('message', payload);
const sendPrivate = ({ toUserId, text }) => socketRef.current.emit('private_message', { toUserId, text });
const setIsTyping = ({ room, isTyping }) => socketRef.current.emit('typing', { room, isTyping });
const joinRoom = (room) => socketRef.current.emit('join_room', { room });
const leaveRoom = (room) => socketRef.current.emit('leave_room', { room });
const markRead = (messageId) => socketRef.current.emit('mark_read', { messageId });
const react = ({ messageId, reaction }) => socketRef.current.emit('react', { messageId, reaction });
const sendFile = ({ room, name, data, mime }) => socketRef.current.emit('file_message', { room, name, data, mime });


return { connected, messages, onlineUsers, typing, sendMessage, sendPrivate, setIsTyping, joinRoom, leaveRoom, markRead, react, sendFile };
}