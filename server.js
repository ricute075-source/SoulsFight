const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

// Cấp quyền truy cập vào thư mục public chứa index.html
app.use(express.static('public'));

// --- BIẾN LƯU TRỮ TRẠNG THÁI GAME ---
let pvpQueue = []; // Hàng đợi 1v1
let coopLobbies = {
    titan: { players: [], max: 4, hostId: null },
    zephyr: { players: [], max: 4, hostId: null },
    ifrit: { players: [], max: 4, hostId: null },
    shadow: { players: [], max: 4, hostId: null },
    omega: { players: [], max: 4, hostId: null },
    world: { players: [], max: 8, hostId: null }
};
let rooms = {}; // Lưu thông tin các phòng đang đánh (1v1 và Co-op)

// --- HÀM TẠO ID PHÒNG RANDOM ---
const generateRoomId = () => Math.random().toString(36).substring(2, 9);

io.on('connection', (socket) => {
    console.log('⚡ Một dũng sĩ vừa kết nối:', socket.id);

    // ==========================================
    // ⚔️ CHẾ ĐỘ 1VS1 (PVP - BO3)
    // ==========================================
    socket.on('findMatch', (playerName) => {
        socket.playerName = playerName;
        pvpQueue.push(socket);

        if (pvpQueue.length >= 2) {
            let p1 = pvpQueue.shift();
            let p2 = pvpQueue.shift();
            let roomId = 'pvp_' + generateRoomId();

            p1.join(roomId);
            p2.join(roomId);

            rooms[roomId] = {
                type: 'pvp',
                p1: p1.id,
                p2: p2.id,
                score: { p1: 0, p2: 0 },
                mapId: Math.floor(Math.random() * 5),
                readyCount: 0
            };

            p1.emit('matchFound', { role: 'p1', roomId: roomId, oppName: p2.playerName, mapId: rooms[roomId].mapId });
            p2.emit('matchFound', { role: 'p2', roomId: roomId, oppName: p1.playerName, mapId: rooms[roomId].mapId });
        }
    });

    socket.on('cancelMatch', () => {
        pvpQueue = pvpQueue.filter(s => s.id !== socket.id);
        // Xóa khỏi sảnh Co-op nếu đang chờ
        for (let type in coopLobbies) {
            coopLobbies[type].players = coopLobbies[type].players.filter(p => p.id !== socket.id);
            if (coopLobbies[type].players.length > 0 && coopLobbies[type].hostId === socket.id) {
                coopLobbies[type].hostId = coopLobbies[type].players[0].id; // Chuyển Host
            }
        }
    });

    socket.on('playerDied', (data) => {
        let room = rooms[data.roomId];
        if (!room || room.type !== 'pvp') return;

        // Cộng điểm cho người sống sót
        let winnerRole = data.loserRole === 'p1' ? 'p2' : 'p1';
        room.score[winnerRole] += 1;

        // Check win Bo3 (Ai chạm 2 trước là thắng)
        if (room.score[winnerRole] === 2) {
            io.to(data.roomId).emit('matchEnd', { winner: winnerRole, score: room.score });
            delete rooms[data.roomId]; // Xóa phòng
        } else {
            io.to(data.roomId).emit('roundEnd', { winner: winnerRole, score: room.score });
            room.readyCount = 0; // Reset đếm ready cho hiệp sau
        }
    });

    socket.on('nextRoundReady', (roomId) => {
        let room = rooms[roomId];
        if (room) {
            room.readyCount += 1;
            if (room.readyCount >= 2) {
                // Đổi map ngẫu nhiên cho hiệp sau
                room.mapId = Math.floor(Math.random() * 5);
                io.to(roomId).emit('startNextRound');
            }
        }
    });


    // ==========================================
    // 🐉 CHẾ ĐỘ CO-OP BOSS HỢP TÁC
    // ==========================================
    socket.on('joinCoopLobby', (data) => {
        let lobby = coopLobbies[data.type];
        if (!lobby) return;

        data.id = socket.id;
        lobby.players.push(data);
        socket.coopType = data.type;

        // Phân quyền Host cho người đầu tiên
        if (lobby.players.length === 1) lobby.hostId = socket.id;
        
        socket.emit('lobbyJoined', { isHost: lobby.hostId === socket.id });
        
        // Báo cho mọi người trong sảnh biết số lượng
        lobby.players.forEach(p => {
            io.to(p.id).emit('lobbyUpdate', { count: lobby.players.length, max: lobby.max });
        });

        // Nếu phòng đầy -> Đếm ngược tự start
        if (lobby.players.length === lobby.max) {
            let countdown = 3;
            let timer = setInterval(() => {
                lobby.players.forEach(p => io.to(p.id).emit('lobbyCountdown', countdown));
                countdown--;
                if (countdown < 0) {
                    clearInterval(timer);
                    startCoopGame(data.type);
                }
            }, 1000);
        }
    });

    socket.on('startCoopEarly', (type) => {
        let lobby = coopLobbies[type];
        if (lobby && lobby.hostId === socket.id) {
            startCoopGame(type);
        }
    });

    socket.on('urgeHost', (type) => {
        let lobby = coopLobbies[type];
        if (lobby && lobby.hostId) {
            io.to(lobby.hostId).emit('hostUrged');
        }
    });

    function startCoopGame(type) {
        let lobby = coopLobbies[type];
        if (!lobby || lobby.players.length === 0) return;

        let roomId = 'coop_' + generateRoomId();
        let baseHp = type === 'world' ? 8000 : 3000;
        let totalHp = baseHp + (lobby.players.length - 1) * (baseHp * 0.5); // Buff máu boss theo số lượng người

        rooms[roomId] = {
            type: 'coop', bossType: type, bossHp: totalHp, maxHp: totalHp, players: lobby.players
        };

        // Gửi data khởi tạo cho từng người
        lobby.players.forEach(p => {
            let playerSocket = io.sockets.sockets.get(p.id);
            if (playerSocket) playerSocket.join(roomId);

            // Tạo danh sách đồng đội trừ bản thân
            let teammates = {};
            lobby.players.forEach(t => {
                if (t.id !== p.id) teammates[t.id] = t;
            });

            io.to(p.id).emit('coopGameInit', {
                roomId: roomId, type: type, isHost: p.id === lobby.hostId,
                bossHp: totalHp, teammates: teammates
            });
        });

        // Reset lobby cho pt sau
        lobby.players = [];
        lobby.hostId = null;
    }

    socket.on('hitCoopBoss', (dmg) => {
        let roomId = Array.from(socket.rooms).find(r => r.startsWith('coop_'));
        let room = rooms[roomId];
        if (room && room.bossHp > 0) {
            room.bossHp -= dmg;
            io.to(roomId).emit('coopBossHpUpdate', room.bossHp);
            if (room.bossHp <= 0) {
                io.to(roomId).emit('coopBossDefeated');
            }
        }
    });

    socket.on('coopStunBoss', (dur) => {
        let roomId = Array.from(socket.rooms).find(r => r.startsWith('coop_'));
        if (roomId) io.to(roomId).emit('bossStunned', dur);
    });

    // --- ĐỒNG BỘ CHUYỂN ĐỘNG & CHIÊU THỨC CHUNG ---
    socket.on('playerUpdate', (data) => {
        socket.to(data.roomId).emit('updateOpponent', data); // Dành cho 1v1
        socket.to(data.roomId).emit('updateTeammate', { id: socket.id, data: data }); // Dành cho Co-op
    });

    socket.on('shoot', (data) => socket.to(data.roomId).emit('opponentShoot', data));
    socket.on('coopShoot', (data) => {
        let roomId = Array.from(socket.rooms).find(r => r.startsWith('coop_'));
        if (roomId) socket.to(roomId).emit('teammateShoot', data);
    });

    socket.on('playerHit', (data) => socket.to(data.roomId).emit('takeDamage', data));
    
    socket.on('healTeammate', (data) => socket.to(data.roomId).emit('receiveHeal', data.amount));
    socket.on('applyStun', (data) => socket.to(data.roomId).emit('takeStun', data.duration));

    // Boss Action (Chỉ Host mới gửi)
    socket.on('bossAction', (data) => {
        let roomId = Array.from(socket.rooms).find(r => r.startsWith('coop_'));
        if (roomId) socket.to(roomId).emit('updateBoss', data);
    });
    socket.on('bossShoot', (data) => {
        let roomId = Array.from(socket.rooms).find(r => r.startsWith('coop_'));
        if (roomId) socket.to(roomId).emit('bossFires', data);
    });

    // ==========================================
    // ❌ XỬ LÝ NGẮT KẾT NỐI
    // ==========================================
    socket.on('disconnect', () => {
        console.log('❌ Một dũng sĩ đã rời đi:', socket.id);
        pvpQueue = pvpQueue.filter(s => s.id !== socket.id);

        for (let type in coopLobbies) {
            coopLobbies[type].players = coopLobbies[type].players.filter(p => p.id !== socket.id);
            if (coopLobbies[type].players.length > 0 && coopLobbies[type].hostId === socket.id) {
                coopLobbies[type].hostId = coopLobbies[type].players[0].id;
            }
        }
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`🚀 SERVER GAME ĐANG CHẠY TẠI: http://localhost:${PORT}`);
});