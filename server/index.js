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
  if (!rooms.has(roomName)) {
    rooms.set(roomName, {
      players: new Map(),
      environment: {
        worldData: null,
        worldTransform: null,
        skyboxData: null,
        sunSettings: null,
      }
    });
  }
  return rooms.get(roomName).players;
}

function cleanupRoom(roomName) {
  // const roomObj = rooms.get(roomName);
  // if (roomObj && roomObj.players.size === 0) {
  //   rooms.delete(roomName); // 一度アップロードしたワールドを維持するために、ルームを削除せず残す
  // }
}

io.on('connection', (socket) => {
  const id = socket.id;
  let currentRoom = null;
  console.log(`[+] Connected: ${id}`);

  // ルームに参加
  socket.on('join-room', ({ room, name, playerId }) => {
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

    // 同じplayerId（同一ブラウザの古い接続）が残っていれば強制削除（ゴースト防止）
    if (playerId) {
      for (const [pid, pstate] of roomPlayers.entries()) {
        if (pstate.playerId === playerId && pid !== id) {
          roomPlayers.delete(pid);
          io.to(currentRoom).emit('player-left', { id: pid });
        }
      }
    }

    // 既存メンバー一覧を新規参加者に送る (Bufferは除外してメタデータのみ送る)
    const existing = [];
    roomPlayers.forEach((state, pid) => {
      const { avatarData, ...rest } = state;
      let info = { id: pid, ...rest };
      if (avatarData) {
        info.avatarInfo = { fileName: avatarData.fileName, type: avatarData.type, size: avatarData.buffer.byteLength };
      }
      existing.push(info);
    });
    socket.emit('init', existing);

    // 初期状態を登録
    roomPlayers.set(id, { playerId: playerId, name: name || id.substring(0, 8), position: { x: 0, y: 0, z: 0 }, rotationY: 0, boneRots: {} });

    // 他のメンバーに参加を通知
    socket.to(currentRoom).emit('player-joined', { id, name: name || id.substring(0, 8) });

    console.log(`[Room:${currentRoom}] ${name || id} joined (${roomPlayers.size} players)`);

    // ルーム情報をクライアントに返す (ワールドモデルや太陽設定などの環境情報も同封)
    const roomObj = rooms.get(currentRoom);
    socket.emit('room-joined', { 
      room: currentRoom, 
      playerCount: roomPlayers.size,
      environment: roomObj ? roomObj.environment : null,
      chatHistory: roomObj && roomObj.chatHistory ? roomObj.chatHistory : []
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
    socket.to(currentRoom).emit('avatar-info', { 
      id, 
      fileName: data.fileName, 
      type: data.type, 
      size: data.buffer.byteLength 
    });
  });

  // クライアントからのアバター本体要求に応答する
  socket.on('request-avatar-buffer', (targetId) => {
    if (!currentRoom) return;
    const roomPlayers = getRoom(currentRoom);
    const targetPlayer = roomPlayers.get(targetId);
    if (targetPlayer && targetPlayer.avatarData) {
      socket.emit('avatar-buffer-response', {
        id: targetId,
        fileName: targetPlayer.avatarData.fileName,
        type: targetPlayer.avatarData.type,
        buffer: targetPlayer.avatarData.buffer
      });
    }
  });

  // ワールドの位置調整（位置、回転、スケール）をルーム内の他の人に転送し、ルーム状態に保存する
  socket.on('world-transform', (data) => {
    if (!currentRoom) return;
    const roomObj = rooms.get(currentRoom);
    if (roomObj) {
      roomObj.environment.worldTransform = data;
    }
    socket.to(currentRoom).emit('world-transformed', data);
  });

  // ワールド3Dモデルデータの共有と保存
  socket.on('world-share', (data) => {
    if (!currentRoom) return;
    const roomObj = rooms.get(currentRoom);
    if (roomObj) {
      roomObj.environment.worldData = data;
    }
    socket.to(currentRoom).emit('world-shared', data);
  });

  // スカイボックス背景画像の共有と保存
  socket.on('skybox-share', (data) => {
    if (!currentRoom) return;
    const roomObj = rooms.get(currentRoom);
    if (roomObj) {
      roomObj.environment.skyboxData = data;
    }
    socket.to(currentRoom).emit('skybox-shared', data);
  });

  // 太陽と時間のパラメータ設定の共有と保存
  socket.on('sun-settings-share', (data) => {
    if (!currentRoom) return;
    const roomObj = rooms.get(currentRoom);
    if (roomObj) {
      roomObj.environment.sunSettings = data;
    }
    socket.to(currentRoom).emit('sun-settings-shared', data);
  });
  // テキストチャットの仲介
  socket.on('chat-msg', (text) => {
    if (!currentRoom) return;
    const roomPlayers = getRoom(currentRoom);
    const player = roomPlayers.get(id);
    const name = player ? player.name : id.substring(0, 8);
    
    // 掲示板用に履歴を保存
    const roomObj = rooms.get(currentRoom);
    if (roomObj) {
      if (!roomObj.chatHistory) roomObj.chatHistory = [];
      roomObj.chatHistory.push({ id, name, text });
      // 最大50件まで保持
      if (roomObj.chatHistory.length > 50) {
        roomObj.chatHistory.shift();
      }
    }

    socket.to(currentRoom).emit('chat-msg', { id, name, text });
  });

  // WebRTC ボイスチャット用シグナリングの仲介
  socket.on('webrtc-offer', ({ to, offer }) => {
    io.to(to).emit('webrtc-offer', { from: id, offer });
  });
  socket.on('webrtc-answer', ({ to, answer }) => {
    io.to(to).emit('webrtc-answer', { from: id, answer });
  });
  socket.on('webrtc-candidate', ({ to, candidate }) => {
    io.to(to).emit('webrtc-candidate', { from: id, candidate });
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
