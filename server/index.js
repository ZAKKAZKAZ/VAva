const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);

const io = new Server(server, {
  cors: { origin: '*', methods: ['GET', 'POST'] },
  maxHttpBufferSize: 1e8, // Allow up to 100MB payloads (VRM/FBX files)
});

// roomName -> Map<socketId, PlayerState>
const rooms = new Map();

function getRoom(roomName) {
  if (!rooms.has(roomName)) rooms.set(roomName, new Map());
  return rooms.get(roomName);
}

function cleanupRoom(roomName) {
  const room = rooms.get(roomName);
  if (room && room.size === 0) rooms.delete(roomName);
}

io.on('connection', (socket) => {
  const id = socket.id;
  let currentRoom = null;
  console.log(`[+] Connected: ${id}`);

  // ルームに参加
  socket.on('join-room', ({ room, name }) => {
    // 以前のルームから退出
    if (currentRoom) {
      const prevRoom = getRoom(currentRoom);
      prevRoom.delete(id);
      socket.leave(currentRoom);
      socket.to(currentRoom).emit('player-left', { id });
      cleanupRoom(currentRoom);
    }

    currentRoom = room || 'default';
    socket.join(currentRoom);
    const roomPlayers = getRoom(currentRoom);

    // 既存メンバー一覧を新規参加者に送る
    const existing = [];
    roomPlayers.forEach((state, pid) => existing.push({ id: pid, ...state }));
    socket.emit('init', existing);

    // 初期状態を登録
    roomPlayers.set(id, { name: name || id.substring(0, 8), position: { x: 0, y: 0, z: 0 }, rotationY: 0, boneRots: {} });

    // 他のメンバーに参加を通知
    socket.to(currentRoom).emit('player-joined', { id, name: name || id.substring(0, 8) });

    console.log(`[Room:${currentRoom}] ${name || id} joined (${roomPlayers.size} players)`);

    // ルーム情報をクライアントに返す (ワールドのトランスフォームがあればそれも同封)
    const roomObj = rooms.get(currentRoom);
    socket.emit('room-joined', { 
      room: currentRoom, 
      playerCount: roomPlayers.size,
      worldTransform: roomObj ? roomObj.worldTransform : null
    });
  });

  // アバターの共有 (モデルデータをルーム内の他プレイヤーに転送しキャッシュする)
  socket.on('avatar-share', (data) => {
    if (!currentRoom) return;
    const roomPlayers = getRoom(currentRoom);
    const player = roomPlayers.get(id);
    if (player) {
      player.avatarData = data;
    }
    socket.to(currentRoom).emit('avatar-shared', { id, ...data });
  });

  // ワールドの位置調整（位置、回転、スケール）をルーム内の他の人に転送し、ルーム状態に保存する
  socket.on('world-transform', (data) => {
    if (!currentRoom) return;
    const roomObj = rooms.get(currentRoom);
    if (roomObj) {
      roomObj.worldTransform = data;
    }
    socket.to(currentRoom).emit('world-transformed', data);
  });
  socket.on('state', (data) => {
    if (!currentRoom) return;
    const roomPlayers = getRoom(currentRoom);
    const existing = roomPlayers.get(id) || {};
    const updated = { ...existing, ...data };
    roomPlayers.set(id, updated);
    socket.to(currentRoom).emit('player-state', { id, ...data });
  });

  // 切断
  socket.on('disconnect', () => {
    if (currentRoom) {
      const room = getRoom(currentRoom);
      room.delete(id);
      io.to(currentRoom).emit('player-left', { id });
      cleanupRoom(currentRoom);
      console.log(`[-] Disconnected: ${id} (room: ${currentRoom})`);
    }
  });
});

// ルーム一覧API（デバッグ用）
app.get('/rooms', (req, res) => {
  const info = {};
  rooms.forEach((players, name) => { info[name] = players.size; });
  res.json(info);
});

// 静的ファイルの配信 (Viteのビルド成果物である dist ディレクトリを配信)
const path = require('path');
app.use(express.static(path.join(__dirname, '../dist')));

// その他のルートは index.html を返す
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, '../dist/index.html'));
});

const PORT = process.env.PORT || 3001;
server.listen(PORT, () => {
  console.log('');
  console.log('  🚀 VRM マルチプレイヤーサーバー起動');
  console.log(`  URL: http://localhost:${PORT}`);
  console.log(`  ルーム一覧: http://localhost:${PORT}/rooms`);
  console.log('');
});
