import React, { useCallback, useEffect, useRef, useState } from "react";
import {
  SignedIn,
  SignedOut,
  RedirectToSignIn,
  SignInButton,
  SignOutButton,
  UserButton,
  useUser,
  useAuth,
} from "@clerk/clerk-react";
import { createSocket } from "./socket";
import "./styles.css";

// small helper to render initials
function initials(name) {
  if (!name) return "U";
  return name
    .split(" ")
    .map((p) => p[0])
    .slice(0, 2)
    .join("")
    .toUpperCase();
}

export default function App() {
  // Clerk
  const { user } = useUser() || {};
  const { getToken } = useAuth();

  // Canonical socket ref + state
  const socketRef = useRef(null);
  const [connected, setConnected] = useState(false);
  const [lastError, setLastError] = useState(null);

  // App data
  const [rooms, setRooms] = useState([]);
  const [onlineUsers, setOnlineUsers] = useState([]);
  const [messages, setMessages] = useState([]);
  const [currentRoom, setCurrentRoom] = useState(() => {
    try { return localStorage.getItem('currentRoom') || 'global'; } catch (e) { return 'global'; }
  });
  // track recently-deleted message ids locally to avoid re-adding from late server responses
  const deletedMessageIds = useRef(new Set());
  const [input, setInput] = useState("");
  const [onlineCount, setOnlineCount] = useState(0); // new

  const appName = import.meta.env.VITE_APP_NAME || "Realtime App";

  // register socket and attach all handlers in one place
  const registerSocket = useCallback((s) => {
    if (!s) return;
    const prev = socketRef.current;
    if (prev && prev !== s) {
      try { prev.removeAllListeners(); prev.disconnect(); } catch (e) {}
    }
    socketRef.current = s;

    // clear previous listeners defensively
    try {
      s.off && s.off();
    } catch (e) {}

    // Connection lifecycle
    s.on("connect", () => {
      console.info("[app] socket connected", s.id);
      setConnected(true);
      setLastError(null);
      // request a fresh rooms/users snapshot
      try { s.emit("rooms_request", null); } catch (e) {}
    });
    s.on("disconnect", (reason) => {
      console.info("[app] socket disconnected", reason);
      setConnected(false);
    });
    s.on("connect_error", (err) => {
      console.error("[app] socket connect_error", err && err.message);
      setLastError(err?.message || String(err));
      setConnected(false);
    });

    // domain events
    // support servers that emit either `rooms` or `roomsList`
    s.on("rooms", (r) => setRooms(Array.isArray(r) ? r : []));
    s.on("roomsList", (r) => {
      try {
        if (!Array.isArray(r)) return setRooms([]);
        setRooms(r.map((x) => ({ name: x.name, id: x.id || x._id })));
      } catch (e) { setRooms([]); }
    });

    // support both `users` and `onlineUsers` payload shapes
    s.on("users", (u) => {
      console.info("[client] received users payload:", u);
      setOnlineUsers(Array.isArray(u) ? u : []);
      try { const inferred = Array.isArray(u) ? u.filter(x => x.online).length : 0; setOnlineCount(inferred); } catch {}
    });
    s.on("onlineUsers", (arr) => {
      try {
        // server may send [{ socketId, username }] shape
        if (!Array.isArray(arr)) return setOnlineUsers([]);
        const mapped = arr.map((x) => ({ id: x.socketId || x.id || x.userId, name: x.username || x.name, online: true }));
        setOnlineUsers(mapped);
        setOnlineCount(mapped.length);
      } catch (e) { setOnlineUsers([]); }
    });
    s.on("recent_messages", (recent) => {
      if (!Array.isArray(recent)) return;
      setMessages((prev) => {
        const map = new Map(prev.map((m) => [m.id || m._id, m]));
        recent.forEach((m) => {
          const id = m._id || m.id;
          if (id && deletedMessageIds.current.has(String(id))) return;
          map.set(id, { ...m, id });
        });
        return Array.from(map.values()).sort((a, b) => (new Date(a.timestamp || a.createdAt || 0) - new Date(b.timestamp || b.createdAt || 0)));
      });
    });
    s.on("room_messages", ({ room, messages: roomMsgs }) => {
      if (!Array.isArray(roomMsgs)) return;
      setMessages((prev) => {
        const map = new Map(prev.map((m) => [m.id || m._id, m]));
        roomMsgs.forEach((m) => {
          const id = m._id || m.id;
          if (id && deletedMessageIds.current.has(String(id))) return;
          map.set(id, { ...m, id });
        });
        return Array.from(map.values()).sort((a, b) => (new Date(a.timestamp || a.createdAt || 0) - new Date(b.timestamp || b.createdAt || 0)));
      });
    });
    // server may emit `roomMessages` (camelCase)
    s.on('roomMessages', ({ room, messages: roomMsgs }) => {
      if (!Array.isArray(roomMsgs)) return;
      setMessages((prev) => {
        const map = new Map(prev.map((m) => [m.id || m._id, m]));
        roomMsgs.forEach((m) => {
          const id = m._id || m.id;
          if (id && deletedMessageIds.current.has(String(id))) return;
          map.set(id, { ...m, id });
        });
        return Array.from(map.values()).sort((a, b) => (new Date(a.timestamp || a.createdAt || 0) - new Date(b.timestamp || b.createdAt || 0)));
      });
    });
    s.on("message", (msg) => {
      try {
        const id = msg._id || msg.id;
        if (id && deletedMessageIds.current.has(String(id))) return;
        const normalized = { ...msg, id };
        setMessages((prev) => {
          if (prev.some((m) => String(m.id || m._id) === String(id))) return prev;
          return [...prev, normalized].sort((a, b) => (new Date(a.timestamp || a.createdAt || 0) - new Date(b.timestamp || b.createdAt || 0)));
        });
      } catch (e) { /* ignore malformed message */ }
    });
    s.on('messageDeleted', ({ messageId }) => {
      try {
        const idStr = String(messageId);
        deletedMessageIds.current.add(idStr);
        setMessages((prev) => prev.filter(m => String(m.id || m._id) !== idStr));
      } catch (e) {}
    });
    s.on('roomCleared', ({ room }) => {
      setMessages((prev) => prev.filter(m => (m.room || 'global') !== room));
    });
    s.on('roomDeleted', ({ room }) => {
      setMessages((prev) => prev.filter(m => (m.room || 'global') !== room));
      setRooms((prev) => prev.filter(r => r.name !== room));
      if (currentRoom === room) setCurrentRoom('global');
    });
    // support either snake_case or camelCase private messages
    s.on("private_message", (msg) => {
      try {
        const id = msg._id || msg.id;
        if (id && deletedMessageIds.current.has(String(id))) return;
        const normalized = { ...msg, id, private: true };
        setMessages((prev) => {
          if (prev.some((m) => String(m.id || m._id) === String(id))) return prev;
          return [...prev, normalized].sort((a, b) => (new Date(a.timestamp || a.createdAt || 0) - new Date(b.timestamp || b.createdAt || 0)));
        });
      } catch (e) {}
      
      try {
        if (("Notification" in window) && Notification.permission === "granted") {
          new Notification(`PM from ${msg.senderName}`, { body: msg.text });
        }
      } catch {}
    });
    s.on('privateMessage', (msg) => {
      try {
        const id = msg._id || msg.id;
        if (id && deletedMessageIds.current.has(String(id))) return;
        const toInsert = { ...msg, id, private: true };
        setMessages((prev) => {
          if (prev.some((m) => String(m.id || m._id) === String(id))) return prev;
          return [...prev, toInsert].sort((a, b) => (new Date(a.timestamp || a.createdAt || Date.now()) - new Date(b.timestamp || b.createdAt || Date.now())));
        });
      } catch (e) {}
      try {
        const senderName = msg.from || msg.fromName || msg.senderName || 'Unknown';
        const senderSocket = msg.fromSocketId || null;
        // auto-open private chat if message is from someone else and we're not already in that PM
        const myId = user?.id || user?.userId || null;
        if (senderName && (!privateChatWith || privateChatWith.name !== senderName)) {
          // attempt to resolve socket id from onlineUsers
          const found = onlineUsers.find(u => (u.name === senderName || u.id === senderSocket));
          const targetId = senderSocket || (found && found.id) || (msg.fromId || null);
          if (targetId) setPrivateChatWith({ id: targetId, name: senderName });
        }
        if (("Notification" in window) && Notification.permission === "granted") {
          new Notification(`PM from ${senderName}`, { body: msg.text || msg.content });
        }
      } catch (e) { /* ignore */ }
    });
    s.on("message_read", ({ messageId, userId }) => {
      setMessages((prev) => prev.map((m) => (m.id === messageId ? { ...m, readBy: Array.from(new Set([...(m.readBy || []), userId])) } : m)));
    });
    // server may emit `messageRead` in other implementations
    s.on('messageRead', ({ messageId, userId }) => {
      setMessages((prev) => prev.map((m) => (m.id === messageId ? { ...m, readBy: Array.from(new Set([...(m.readBy || []), userId])) } : m)));
    });
    // new: authoritative count from server
    s.on("users_count", (count) => {
      console.info("[client] received users_count:", count);
      setOnlineCount(Number(count) || 0);
    });
    s.on('notification', (n) => {
      try { console.info('[client] notification', n); } catch (e) {}
    });
    s.on('reaction', (r) => {
      try {
        setMessages((prev) => prev.map((m) => (m.id === r.messageId ? { ...m, reactions: { ...(m.reactions || {}), [r.reaction || r.emoji]: r.count } } : m)));
      } catch (e) {}
    });

    // ensure server snapshot sent if client asked
    try { s.emit("rooms_request", null); } catch (e) { /* ignore */ }
  }, []);

  // initialize socket when user signs in
  useEffect(() => {
    if (!user) {
      if (socketRef.current) {
        try { socketRef.current.removeAllListeners(); socketRef.current.disconnect(); } catch (e) {}
        socketRef.current = null;
      }
      setConnected(false);
      return;
    }

    let mounted = true;
    (async () => {
      setLastError(null);
      try {
        const token = await getToken().catch(() => null);
        const userPayload = { id: user?.id, fullName: user?.fullName || user?.firstName || user?.primaryEmailAddress?.emailAddress || "User" };
        const s = createSocket(token, userPayload);
        if (!mounted) return;
        registerSocket(s);

        // NEW: ensure the server knows who joined and which room to join
        s.once("connect", () => {
          try {
            const uname = user?.fullName || user?.firstName || user?.primaryEmailAddress?.emailAddress || user?.id || "Anonymous";
            // announce presence (server tracks online users)
            s.emit("join", { username: uname });
            // ensure we join the current room (default 'global')
            s.emit("join_room", { room: currentRoom || "global" });
          } catch (e) {
            console.warn("[app] join emit failed", e);
          }
        });

        s.connect();
      } catch (err) {
        console.error("[app] init socket failed", err);
        setLastError(String(err));
      }
    })();

    return () => { mounted = false; };
  }, [user, getToken, registerSocket /* intentionally not adding currentRoom to avoid re-init loops */]);

  // clear locally-tracked deleted IDs when switching rooms so they don't block other rooms
  useEffect(() => {
    try { deletedMessageIds.current.clear(); } catch (e) {}
  }, [currentRoom]);

  // derive visible messages for current room
  const [privateChatWith, setPrivateChatWith] = useState(null); // { id, name }

  const visibleMessages = React.useMemo(() => {
    if (privateChatWith) {
      const myName = user?.fullName || user?.firstName || user?.primaryEmailAddress?.emailAddress || user?.id || 'You';
      return messages.filter((m) => m.private && ((m.from === myName && m.to === privateChatWith.name) || (m.from === privateChatWith.name && m.to === myName)));
    }
    return messages.filter((m) => (m.room || "global") === (currentRoom || "global"));
  }, [messages, currentRoom, privateChatWith, user]);

  // Infinite scroll: load older messages when scrolling near top
  const messageListRef = React.useRef();
  const [loadingOlder, setLoadingOlder] = React.useState(false);
  const [hasMoreOlder, setHasMoreOlder] = React.useState(true);

  const loadOlderMessages = async () => {
    if (loadingOlder || !hasMoreOlder) return;
    setLoadingOlder(true);
    try {
      const room = currentRoom || 'global';
      // find oldest timestamp in visible messages
      const oldest = visibleMessages.length ? Math.min(...visibleMessages.map((m) => m.timestamp || Date.now())) : Date.now();
      const resp = await fetch(`${API_BASE}/messages/paginate?room=${encodeURIComponent(room)}&before=${oldest}&limit=50`);
      const json = await resp.json().catch(() => null);
      if (resp.ok && json && Array.isArray(json.messages)) {
        const older = json.messages || [];
        if (older.length === 0) setHasMoreOlder(false);
        // prepend older messages if not already present
        setMessages((prev) => {
          const map = new Map(prev.map((m) => [m.id || m._id, m]));
          older.forEach((m) => {
            const id = m._id || m.id;
            if (!id) return;
            if (deletedMessageIds.current.has(String(id))) return;
            if (!map.has(id)) map.set(id, { ...m, id });
          });
          return Array.from(map.values()).sort((a, b) => (new Date(a.timestamp || a.createdAt || 0) - new Date(b.timestamp || b.createdAt || 0)));
        });
        // adjust scroll to keep viewport stable
        try {
          const el = messageListRef.current;
          if (el) {
            const prevHeight = el.scrollHeight;
            // let DOM update
            setTimeout(() => { el.scrollTop = el.scrollHeight - prevHeight + el.scrollTop; }, 50);
          }
        } catch (e) {}
      } else {
        setHasMoreOlder(false);
      }
    } catch (err) {
      console.warn('loadOlderMessages failed', err);
    } finally {
      setLoadingOlder(false);
    }
  };

  // attach scroll handler
  React.useEffect(() => {
    const el = messageListRef.current;
    if (!el) return;
    const onScroll = () => {
      if (el.scrollTop < 120 && !loadingOlder && hasMoreOlder) {
        loadOlderMessages();
      }
    };
    el.addEventListener('scroll', onScroll);
    return () => el.removeEventListener('scroll', onScroll);
  }, [messageListRef.current, loadingOlder, hasMoreOlder, visibleMessages, currentRoom]);

  // mark visible messages as read (avoid marking own messages)
  useEffect(() => {
    const s = socketRef.current;
    if (!s || !connected) return;
    const myId = user?.id || user?.userId;
    visibleMessages.forEach((m) => {
      if (!m) return;
      const alreadyRead = Array.isArray(m.readBy) && m.readBy.includes(myId);
      if (!alreadyRead && m.senderId !== myId) {
        try {
          s.emit("mark_read", { messageId: m.id }, (ack) => { if (ack && !ack.ok) console.warn("mark_read ack error", ack); });
        } catch (e) {
          console.warn("mark_read emit failed", e);
        }
      }
    });
  }, [visibleMessages, connected, user]);

  // scroll to bottom on new incoming messages (unless user is reading older messages)
  React.useEffect(() => {
    const el = messageListRef.current;
    if (!el) return;
    // If user is near bottom (within 200px), auto-scroll
    const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 200;
    if (nearBottom) {
      setTimeout(() => { el.scrollTop = el.scrollHeight; }, 50);
    }
  }, [visibleMessages.length]);

  // safe getter
  const getSocket = () => socketRef.current;

  // helper to wait for socket to connect
  const waitForConnect = (s, timeout = 5000) =>
    new Promise((resolve) => {
      if (!s) return resolve(false);
      if (s.connected) return resolve(true);
      let done = false;
      const onConnect = () => {
        if (done) return;
        done = true;
        s.off("connect", onConnect);
        clearTimeout(t);
        resolve(true);
      };
      const t = setTimeout(() => {
        if (done) return;
        done = true;
        try { s.off("connect", onConnect); } catch (e) {}
        resolve(false);
      }, timeout);
      try { s.once("connect", onConnect); } catch (e) { clearTimeout(t); resolve(false); }
    });

  // Create room: ensure socket exists & connected (create if needed), wait for connect, then emit create_room
  const createRoom = async () => {
    const nameRaw = prompt("Room name:");
    const name = nameRaw?.trim();
    if (!name) return;

    let s = getSocket();

    // If no socket, create one (same flow as init): request token and create
    if (!s) {
      try {
        const token = await getToken().catch(() => null);
        const userPayload = { id: user?.id, fullName: user?.fullName || user?.firstName || user?.primaryEmailAddress?.emailAddress || "User" };
        const created = createSocket(token, userPayload);
        registerSocket(created);
        created.connect();
        s = created;
      } catch (err) {
        console.error("[createRoom] failed to create socket:", err);
        return alert("Unable to connect to server");
      }
    }

    // Wait for connection (timeout)
    const ok = await waitForConnect(s, 5000);
    if (!ok) {
      console.error("[createRoom] socket failed to connect in time");
      return alert("Failed to connect to server — try again");
    }

    // Emit create_room and handle ack
    // emit both legacy and modern event names
    s.emit("create_room", { name }, (res) => {});
    s.emit("createRoom", { name }, (res) => {
      console.info("[app] create_room ack", res);
      if (!res) return alert("No response from server");
      if (!res.ok) return alert("Create room failed: " + (res.error || "unknown"));
      // success: switch to the new room and persist
      setPrivateChatWith(null);
      const newRoomName = res.room?.name || name;
      setCurrentRoom(newRoomName);
      try { localStorage.setItem('currentRoom', newRoomName); } catch (e) {}
      // request fresh rooms snapshot
      try { s.emit("rooms_request", null); } catch (e) {}
    });
  };

  // Join room: ensure connected then emit join_room (similar guarantees)
  const joinRoom = async (room) => {
    if (!room) return;
    let s = getSocket();
    if (!s) {
      try {
        const token = await getToken().catch(() => null);
        const userPayload = { id: user?.id, fullName: user?.fullName || user?.firstName || user?.primaryEmailAddress?.emailAddress || "User" };
        const created = createSocket(token, userPayload);
        registerSocket(created);
        created.connect();
        s = created;
      } catch (err) {
        console.error("[joinRoom] failed to create socket:", err);
        return alert("Unable to connect to server");
      }
    }

    const ok = await waitForConnect(s, 5000);
    if (!ok) {
      console.error("[joinRoom] socket failed to connect in time");
      return alert("Failed to connect to server — try again");
    }

    s.emit("join_room", { room }, (res) => {
      console.info("[app] join_room ack", res);
      if (!res) return alert("No response from server");
      if (!res.ok) return alert("Join failed: " + (res.error || "unknown"));
      setPrivateChatWith(null);
      setCurrentRoom(room);
      try { localStorage.setItem('currentRoom', room); } catch (e) {}
      // server will send room_messages via "room_messages" event — UI will receive them via registerSocket handlers
    });
  };

  // Leave room helper
  const leaveRoom = (room) => {
    if (!room) return;
    const s = getSocket();
    try {
      if (!confirm(`Leave room '${room}'? You can re-join later.`)) return;
      s && s.emit && s.emit('leave_room', { room }, (res) => {
        console.info('[app] leave_room ack', res);
      });
      if (currentRoom === room) {
        setCurrentRoom('global');
        try { localStorage.setItem('currentRoom', 'global'); } catch (e) {}
      }
    } catch (e) { console.warn('leaveRoom failed', e); }
  };

  // Send private message (prompt for quick demo)
  const sendPrivateMessage = (toUserId, toName) => {
    const s = getSocket();
    if (!s) return alert('Not connected');
    const text = prompt(`Send private message to ${toName || toUserId}:`);
    if (!text) return;
    try {
      const payload = { content: text, from: user?.fullName || user?.firstName || user?.primaryEmailAddress?.emailAddress || 'You' };
      s.emit('privateMessage', { toSocketId: toUserId, payload }, (ack) => { if (ack && !ack.ok) console.warn('privateMessage ack', ack); });
    } catch (e) { console.error('private_message emit failed', e); }
  };

  // Reaction helper
  const sendReaction = (messageId, reaction) => {
    const s = getSocket();
    if (!s) return;
    try { s.emit('reaction', { messageId, emoji: reaction, by: user?.fullName || user?.id }); } catch (e) { console.warn('reaction emit failed', e); }
  };

  // Typing indicator: debounce stop typing
  const typingTimers = useRef(new Map());
  const emitTyping = (isTyping) => {
    const s = socketRef.current;
    try {
      s && s.emit && s.emit('typing', { room: currentRoom || 'global', isTyping });
    } catch (e) {}
  };


  // Single, canonical sendMessageToRoom implementation (remove duplicates)
  const sendMessageToRoom = React.useCallback(() => {
    const s = getSocket();
    if (!s) {
      setLastError("Not connected");
      return;
    }
    const text = (input || "").trim();
    if (!text) return;

    // send message to the current room with server ack
    try {
      const fromName = user?.fullName || user?.firstName || user?.primaryEmailAddress?.emailAddress || 'Anonymous';
      if (privateChatWith) {
        // send a private message to the selected socketId
        const payload = { content: text, from: fromName };
        s.emit('privateMessage', { toSocketId: privateChatWith.id, payload }, (ack) => { if (ack && !ack.ok) console.warn('privateMessage ack', ack); });
      } else {
        // server expects { content, from, room }
        const payload = { content: text, from: fromName, room: currentRoom || 'global' };
        s.emit("message", payload, (ack) => {
          if (ack && !ack.ok) {
            console.warn("message ack error", ack);
          }
        });
      }
    } catch (err) {
      console.error("emit message failed", err);
      setLastError(String(err));
    }

    setInput("");
  }, [input, currentRoom]);

  // File picker: read file as base64 and emit via socket (demo flow)
  const fileInputRef = React.useRef();
  const onChooseFile = () => fileInputRef.current && fileInputRef.current.click();
  const API_BASE = import.meta.env.VITE_SERVER_URL || import.meta.env.VITE_SOCKET_URL || 'http://localhost:3000';

  const onFileChange = async (e) => {
    const f = e.target.files && e.target.files[0];
    if (!f) return;
    // Try multipart upload first (Option B)
    const form = new FormData();
    form.append('file', f);
    try {
      const resp = await fetch(`${API_BASE}/upload`, { method: 'POST', body: form });
      const json = await resp.json().catch(() => null);
      if (resp.ok && json && json.ok && json.url) {
        const s = getSocket();
        if (s && s.emit) {
          const payload = { content: '', from: user?.fullName || user?.firstName || user?.primaryEmailAddress?.emailAddress || 'Anonymous', room: currentRoom || 'global', file: { url: `${API_BASE}${json.url}`, name: f.name, mime: f.type } };
          s.emit('message', payload, (ack) => {
            if (ack && !ack.ok) console.warn('file message ack', ack);
          });
        }
        e.target.value = '';
        return;
      }
    } catch (err) {
      console.warn('Upload via /upload failed, falling back to base64', err);
    }

    // Fallback to base64 socket send for demo
    try {
      const reader = new FileReader();
      reader.onload = () => {
        try {
          const s = getSocket();
          const dataUrl = reader.result; // data:<mime>;base64,....
          if (s && s.emit) {
            s.emit('file_message', { room: currentRoom || 'global', name: f.name, data: dataUrl, mime: f.type }, (ack) => {
              if (ack && !ack.ok) console.warn('file_message ack', ack);
            });
          }
        } catch (err) { console.error('file send failed', err); }
      };
      reader.readAsDataURL(f);
    } catch (err) {
      console.error('Fallback file read failed', err);
    }
    // reset input so same file can be reselected later
    e.target.value = '';
  };

  // UI (kept simple)
  return (
    <>
      <SignedIn>
        <div className="app-shell">
          <div className="container">
            <header className="app-header">
              <div className="brand">
                <div className="logo">RC</div>
                <div className="title">
                  <div className="app-name">{appName}</div>
                  <div className="app-tag">Fast · Secure · Realtime</div>
                </div>
              </div>

              <div style={{ marginLeft: "auto", display: "flex", alignItems: "center", gap: 12 }}>
                <div className="badge" title="connection status">
                  <span className={`status-dot ${connected ? "status-connected" : "status-disconnected"}`} />
                  <span style={{ color: connected ? "#86efac" : "#fca5a5", fontSize: 13, fontWeight: 600 }}>
                    {connected ? "connected" : (lastError ? `error: ${lastError}` : "disconnected")}
                  </span>
                </div>

                <button className="badge" onClick={() => { const s = getSocket(); if (s) s.connect(); else alert("Connect will be automatic when signed in."); }}>Connect</button>
                <button className="badge" onClick={() => { const s = getSocket(); if (s) { s.disconnect(); setConnected(false); } }}>Disconnect</button>

                <UserButton />
                <SignOutButton className="badge">Sign out</SignOutButton>
              </div>
            </header>

            <div className="layout">
              <aside className="sidebar">
                <div className="users-card">
                  <h4>Rooms</h4>
                  <div style={{ display: "flex", gap: 8, marginBottom: 8 }}>
                    <button className="btn btn-primary btn--small" onClick={createRoom}>New Room</button>
                    <button className="btn btn-ghost btn--small" onClick={() => joinRoom("global")}>Global</button>
                  </div>

                  <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                    {rooms.length === 0 ? <div className="empty">No rooms</div> : rooms.map((r) => (
                      <div key={r.name} style={{ display: "flex", alignItems: "center", gap: 8, padding: 8, borderRadius: 8 }}>
                        <div style={{ fontWeight: 700 }}>{r.name}</div>
                        <div style={{ marginLeft: "auto", display: "flex", gap: 8 }}>
                          <button className="btn btn-ghost btn--small" onClick={() => joinRoom(r.name)}>Join</button>
                          <button className="btn btn-ghost btn--small" onClick={() => { if (!confirm(`Clear all messages in '${r.name}'? This cannot be undone.`)) return; const s = getSocket(); s && s.emit && s.emit('clearRoom', { room: r.name }, (ack) => { if (!ack || !ack.ok) console.warn('clearRoom failed', ack); }); }}>Clear</button>
                          <button className="btn btn-ghost btn--small" onClick={() => {
                            if (!confirm(`Delete room '${r.name}'? This will remove all messages.`)) return;
                            const s = getSocket(); s && s.emit && s.emit('deleteRoom', { room: r.name }, (ack) => { if (!ack || !ack.ok) return alert('Delete failed: ' + (ack?.error||'unknown')); try { s.emit('rooms_request'); } catch {} });
                          }}>Delete</button>
                          {currentRoom === r.name && r.name !== "global" && <button className="btn btn-outline btn--small" onClick={() => leaveRoom(r.name)}>Leave</button>}
                        </div>
                      </div>
                    ))}
                  </div>

                  <hr style={{ margin: "12px 0", borderColor: "rgba(255,255,255,0.03)" }} />

                  <h4>Users</h4>
                  <div className="users-list" style={{ marginTop: 8 }}>
                    {onlineUsers.length === 0 ? <div className="empty">No users</div> : onlineUsers.map((u) => (
                      <div className="user-row" key={u.id}>
                        <div className="avatar">{initials(u.name || u.id)}</div>
                        <div className="user-meta">
                          <div className="user-name">{u.name || u.id}</div>
                          <div className="user-status">{u.online ? "Online" : "Offline"}</div>
                        </div>
                        <div style={{ marginLeft: "auto", display: "flex", gap: 8 }}>
                          <button className="btn btn-ghost btn--small" onClick={() => { setPrivateChatWith({ id: u.id, name: u.name || u.id }); }}>Open PM</button>
                          <button className="btn btn-ghost btn--small" onClick={() => sendPrivateMessage(u.id, u.name)}>PM</button>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              </aside>

              <main className="chat-panel">
                <div className="chat-header">
                  <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                    {privateChatWith ? (
                      <>
                        <button className="btn btn-ghost btn--small" onClick={() => setPrivateChatWith(null)}>← Back</button>
                        <h2 style={{ margin: 0 }}>Private: {privateChatWith.name}</h2>
                      </>
                    ) : (
                      <h2 style={{ margin: 0 }}>{currentRoom === "global" ? "Global Chat" : `Room: ${currentRoom}`}</h2>
                    )}
                  </div>
                  <div style={{ fontSize: 13, color: "var(--muted)" }}>{onlineCount} online</div>
                </div>

                <div className="chat-card">
                  <div ref={messageListRef} className="message-list" style={{ display: "flex", flexDirection: "column", height: '60vh', overflowY: 'auto' }}>
                    {loadingOlder && (
                      <div style={{ padding: 12, textAlign: 'center' }}>
                        <div className="loading-top" style={{ display: 'inline-flex', alignItems: 'center', justifyContent: 'center' }}>
                          <svg className="spinner-svg" viewBox="0 0 50 50" aria-hidden="true">
                            <circle cx="25" cy="25" r="20" fill="none" stroke="rgba(255,255,255,0.08)" strokeWidth="4" />
                            <path d="M25 5 A20 20 0 0 1 45 25" stroke="white" strokeWidth="4" strokeLinecap="round" fill="none" opacity="0.9">
                              <animateTransform attributeName="transform" type="rotate" from="0 25 25" to="360 25 25" dur="0.9s" repeatCount="indefinite" />
                            </path>
                          </svg>
                          <div>Loading older messages…</div>
                        </div>
                      </div>
                    )}
                    {!hasMoreOlder && (
                      <div style={{ padding: 8, textAlign: 'center', color: 'var(--muted)', fontSize: 12 }}>— start of history —</div>
                    )}
                    {visibleMessages.length === 0 ? (
                      <div className="empty">No messages yet</div>
                    ) : (
                      visibleMessages.map((m, i) => {
                        const sent = m.senderId === user?.id || m.senderId === user?.userId;
                        return (
                          <div key={m.id || m._id || `${m.timestamp || Date.now()}-${i}`} className={`message-bubble ${sent ? "message-sent" : "message-recv"}`} style={{ marginBottom: 10 }}>
                            <div className="message-meta">
                              <div style={{ fontWeight: 700 }}>{m.senderName || m.from}</div>
                              <div>{m.timestamp ? new Date(m.timestamp).toLocaleTimeString() : ""}</div>
                            </div>
                            <div style={{ marginTop: 6 }}>{m.text || m.content}
                              <div style={{ marginTop: 6 }}>
                                <button className="btn btn-ghost btn--small" onClick={() => {
                                  const s = getSocket();
                                  if (!s) return alert('Not connected');
                                  s.emit('deleteMessage', { messageId: m.id || m._id }, (ack) => { if (!ack || !ack.ok) return alert('Delete failed'); });
                                }}>Delete</button>
                              </div>
                              {m.file && (m.file.url || m.file.data) && (
                                <div style={{ marginTop: 8 }}>
                                  {m.file.url ? (
                                    <a href={m.file.url} target="_blank" rel="noreferrer">{m.file.name || 'file'}</a>
                                  ) : (
                                    <div>
                                      {/* inline base64 preview for images */}
                                      {m.file.mime && m.file.mime.startsWith('image/') ? (
                                        <img src={m.file.data} alt={m.file.name} style={{ maxWidth: 240, display: 'block', marginTop: 6 }} />
                                      ) : (
                                        <a href={m.file.data} target="_blank" rel="noreferrer">{m.file.name || 'file'}</a>
                                      )}
                                    </div>
                                  )}
                                </div>
                              )}
                            </div>

                            {/* reactions */}
                            <div style={{ display: 'flex', gap: 8, marginTop: 8, alignItems: 'center' }}>
                              <div style={{ display: 'flex', gap: 6 }}>
                                {m.reactions && Object.keys(m.reactions).map((r) => (
                                  <div key={r} className="reaction-pill">{r} <span className="reaction-count">{m.reactions[r]}</span></div>
                                ))}
                              </div>

                              <div style={{ marginLeft: 'auto', display: 'flex', gap: 6 }}>
                                <button className="btn-ghost small" onClick={() => sendReaction(m.id, '👍')}>👍</button>
                                <button className="btn-ghost small" onClick={() => sendReaction(m.id, '❤️')}>❤️</button>
                                <button className="btn-ghost small" onClick={() => sendReaction(m.id, '😂')}>😂</button>
                              </div>
                            </div>

                            {/* read receipts */}
                            <div style={{ fontSize: 11, color: 'var(--muted)', marginTop: 6 }}>
                              {Array.isArray(m.readBy) && m.readBy.length > 0 && (
                                <span>Read by {m.readBy.length}</span>
                              )}
                            </div>
                          </div>
                        );
                      })
                    )}
                  </div>

                  <div className="composer">
                    <div className="input-box">
                      <input
                        className="input-field"
                        value={input}
                        onChange={(e) => {
                          const val = e.target.value;
                          setInput(val);
                          // emit typing true and debounce stop
                          try {
                            emitTyping(true);
                            const key = 'typing';
                            if (typingTimers.current.has(key)) clearTimeout(typingTimers.current.get(key));
                            const t = setTimeout(() => { emitTyping(false); typingTimers.current.delete(key); }, 1200);
                            typingTimers.current.set(key, t);
                          } catch (e) { /* ignore */ }
                        }}
                        placeholder="Type a message..."
                        onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); sendMessageToRoom(); } }}
                      />
                      <input ref={fileInputRef} type="file" style={{ display: 'none' }} onChange={onFileChange} />
                    </div>
                    <div style={{ display: 'flex', gap: 8 }}>
                      <button type="button" onClick={onChooseFile} className="btn btn-ghost">📎</button>
                      <button onClick={sendMessageToRoom} className="send-btn">Send</button>
                    </div>
                  </div>
                </div>
              </main>
            </div>
          </div>
        </div>
      </SignedIn>

      <SignedOut>
        <RedirectToSignIn />
        <div style={{ minHeight: "70vh", display: "flex", alignItems: "center", justifyContent: "center", flexDirection: "column", color: "#e6eef8" }}>
          <h3>Please sign in to access {appName}</h3>
          <p style={{ color: "#9aa4b2" }}>You will be redirected to the secure sign-in flow.</p>
          <SignInButton mode="modal">Sign in</SignInButton>
        </div>
      </SignedOut>
    </>
  );
}
