'use strict';
const http   = require('http');
const fs     = require('fs');
const path   = require('path');
const crypto = require('crypto');
const { WebSocketServer, WebSocket } = require('ws');

// ── CONSTANTS ──────────────────────────────────────────────────────────────
const PORT       = process.env.PORT || 3000;
const GRACE_MS   = 30_000;   // reconnect window
const MAX_CHAT   = 80;
const MAX_LOG    = 200;
const PLAYER_COLORS = ['#0a2118','#1a5fa8','#8a5c00','#b52a2a','#6b35a8','#2a6e8a'];

// ── STATIC FILE ────────────────────────────────────────────────────────────
const CLIENT_HTML = fs.readFileSync(path.join(__dirname, 'client.html'), 'utf8');

// ── SERVER STATE ───────────────────────────────────────────────────────────
const lobbies  = {};   // id → lobbyObj
const wsState  = new WeakMap();  // ws → { lobbyId, seat, token }
const sessions = {};   // token → { lobbyId, seat, name }

// ── LOBBY FACTORY ──────────────────────────────────────────────────────────
function createLobby(id, name) {
  lobbies[id] = {
    id, name,
    maxPlayers: 6,
    sockets:  new Array(6).fill(null),   // ws per seat
    names:    new Array(6).fill(''),
    tokens:   new Array(6).fill(null),
    graceTimers: new Array(6).fill(null),
    locked: false,
    game: null,
  };
}

createLobby('M1', 'Mesa #1');
createLobby('M2', 'Mesa #2');
createLobby('M3', 'Mesa #3');

// ── HELPERS ────────────────────────────────────────────────────────────────
function token() { return crypto.randomBytes(12).toString('hex'); }

function send(ws, obj) {
  if (ws && ws.readyState === WebSocket.OPEN)
    ws.send(JSON.stringify(obj));
}

function broadcastLobby(lobby, obj, excludeSeat = -1) {
  lobby.sockets.forEach((ws, i) => {
    if (i !== excludeSeat) send(ws, obj);
  });
}

// ── DICE ───────────────────────────────────────────────────────────────────
function rollDice(notation) {
  // e.g. "3d6", "1d20", "2d6"
  const m = /^(\d+)d(\d+)$/i.exec(notation.trim());
  if (!m) return null;
  const count = Math.min(parseInt(m[1]), 20);
  const sides = parseInt(m[2]);
  if (![4,6,8,10,12,20,100].includes(sides)) return null;
  const rolls = Array.from({length: count}, () => Math.floor(Math.random() * sides) + 1);
  return { notation, rolls, total: rolls.reduce((a,b) => a+b, 0), ts: Date.now() };
}

// ── LOBBY VIEW (for lobby screen) ─────────────────────────────────────────
function lobbyView(lobby) {
  const occupied = lobby.names.filter(n => n).length;
  const hasGM = !!lobby.names[0];
  return {
    id:          lobby.id,
    name:        lobby.name,
    maxPlayers:  lobby.maxPlayers,
    playerCount: occupied,
    hasGM,
    locked:      !!lobby.locked,
    inGame:      !!(lobby.game && lobby.game.phase === 'PLAYING'),
    playerNames: lobby.names.filter(n => n),
  };
}

function broadcastLobbies() {
  const list = Object.values(lobbies).map(lobbyView);
  // broadcast to all connected ws not in a game
  Object.values(lobbies).forEach(lb => {
    lb.sockets.forEach(ws => send(ws, { type: 'LOBBIES', lobbies: list }));
  });
  // also send to unjoined connections — tracked below
  unjoined.forEach(ws => send(ws, { type: 'LOBBIES', lobbies: list }));
}

// ── GAME INIT ──────────────────────────────────────────────────────────────
function initGame(lobby) {
  if (lobby.game) return;
  lobby.game = {
    phase:      'PLAYING',
    sceneText:  '',
    location:   '',
    mediaPush:  null,
    chat:       [],
    sceneLog:   [],
    characters: new Array(6).fill(null),  // character per seat
    lastAction: new Array(6).fill(''),
    diceResults: new Array(6).fill(null),
    npcs: [],          // active NPCs in scene
  };
}

// ── GAME STATE VIEW ────────────────────────────────────────────────────────
function buildGameState(lobby, forSeat) {
  const g = lobby.game;
  if (!g) return null;

  const players = lobby.names.map((name, i) => {
    if (!name) return null;
    return {
      seat:        i,
      name,
      isGM:        i === 0,
      online:      !!lobby.sockets[i],
      color:       PLAYER_COLORS[i],
      character:   g.characters[i],
      lastAction:  g.lastAction[i],
      diceResults: g.diceResults[i],
    };
  }).filter(Boolean);

  return {
    phase:      g.phase,
    tableName:  lobby.name,
    locked:     !!lobby.locked,
    location:   g.location || '',
    mySeat:     forSeat,
    isGM:       forSeat === 0,
    sceneText:  g.sceneText,
    mediaPush:  g.mediaPush,
    players,
    chat:       g.chat.slice(-MAX_CHAT),
    sceneLog:   g.sceneLog.slice(-MAX_LOG),
    myCharacter: g.characters[forSeat],
    npcs:        g.npcs || [],
  };
}

function broadcastGameState(lobby) {
  lobby.sockets.forEach((ws, seat) => {
    if (ws && lobby.names[seat]) {
      const state = buildGameState(lobby, seat);
      send(ws, { type: 'GAME_STATE', state });
    }
  });
}

// ── LOG HELPER ─────────────────────────────────────────────────────────────
function addLog(lobby, entry) {
  if (!lobby.game) return;
  lobby.game.sceneLog.push({ ...entry, ts: Date.now() });
  if (lobby.game.sceneLog.length > MAX_LOG)
    lobby.game.sceneLog.shift();
}

function addChat(lobby, seat, name, text, isGM) {
  if (!lobby.game) return;
  lobby.game.chat.push({ seat, name, text, isGM, ts: Date.now() });
  if (lobby.game.chat.length > MAX_CHAT)
    lobby.game.chat.shift();
}

// ── UNJOINED WS SET ────────────────────────────────────────────────────────
const unjoined = new Set();

// ── JOIN LOGIC ─────────────────────────────────────────────────────────────
function handleJoin(ws, lobbyId, playerName) {
  const lobby = lobbies[lobbyId];
  if (!lobby) return send(ws, { type:'ERROR', text:'Mesa não encontrada.' });
  if (!playerName || !playerName.trim())
    return send(ws, { type:'ERROR', text:'Nome inválido.' });

  const name = playerName.trim().slice(0, 24);

  // Find free seat
  let seat = -1;
  for (let i = 0; i < lobby.maxPlayers; i++) {
    if (!lobby.names[i]) { seat = i; break; }
  }
  if (seat === -1) return send(ws, { type:'ERROR', text:'Mesa cheia.' });

  // Block new players if GM locked the table (seat 0 = GM always allowed)
  if (lobby.locked && seat !== 0)
    return send(ws, { type:'ERROR', text:'Mesa fechada pelo GM.' });

  // Kick previous connection if any
  const oldWs = lobby.sockets[seat];
  if (oldWs && oldWs !== ws) oldWs.close();

  const tok = token();
  lobby.sockets[seat] = ws;
  lobby.names[seat]   = name;
  lobby.tokens[seat]  = tok;
  sessions[tok]       = { lobbyId, seat, name };
  wsState.set(ws, { lobbyId, seat, token: tok });
  unjoined.delete(ws);

  // Init game on first join
  if (!lobby.game) initGame(lobby);

  send(ws, { type:'JOINED', token: tok, lobbyId, seat, isGM: seat === 0, name });

  addChat(lobby, seat, name, `${seat === 0 ? '🌿 [GM] ' : ''}${name} entrou na mesa.`, seat === 0);
  broadcastGameState(lobby);
  broadcastLobbies();
}

// ── LEAVE LOGIC ────────────────────────────────────────────────────────────
function handleLeave(ws, reason = 'disconnect') {
  const state = wsState.get(ws);
  if (!state) return;

  const { lobbyId, seat, token: tok } = state;
  const lobby = lobbies[lobbyId];
  if (!lobby) return;

  clearTimeout(lobby.graceTimers[seat]);

  if (reason === 'explicit') {
    // Clean removal
    lobby.sockets[seat] = null;
    lobby.names[seat]   = '';
    lobby.tokens[seat]  = null;
    delete sessions[tok];
    wsState.delete(ws);
    if (lobby.game) {
      addChat(lobby, seat, lobby.names[seat] || '?', `Jogador saiu da mesa.`, seat === 0);
      broadcastGameState(lobby);
    }
    broadcastLobbies();
  } else {
    // Grace period — keep the seat, allow reconnect
    lobby.sockets[seat] = null;
    lobby.graceTimers[seat] = setTimeout(() => {
      // Final disconnect after grace
      lobby.names[seat]  = '';
      lobby.tokens[seat] = null;
      delete sessions[tok];
      if (lobby.game) {
        broadcastGameState(lobby);
      }
      broadcastLobbies();
    }, GRACE_MS);
    if (lobby.game) broadcastGameState(lobby);
  }
}

// ── WEBSOCKET SERVER ───────────────────────────────────────────────────────
const server = http.createServer((req, res) => {
  // Serve story log JSON
  const urlParsed = new URL(req.url, `http://localhost`);
  if (urlParsed.pathname === '/log') {
    const lobbyId = urlParsed.searchParams.get('lobby');
    const lobby = lobbies[lobbyId];
    if (!lobby || !lobby.game) {
      res.writeHead(404); res.end('Not found'); return;
    }
    const json = JSON.stringify({
      table: lobby.name,
      exportedAt: new Date().toISOString(),
      sceneLog: lobby.game.sceneLog,
    }, null, 2);
    res.writeHead(200, {
      'Content-Type': 'application/json',
      'Content-Disposition': `attachment; filename="musgo-log-${lobbyId}-${Date.now()}.json"`,
    });
    res.end(json);
    return;
  }

  // Serve /docs/*.pdf static files
  if (urlParsed.pathname.startsWith('/docs/')) {
    const safeName = path.basename(urlParsed.pathname);   // strip any traversal
    const filePath = path.join(__dirname, 'public', 'docs', safeName);
    if (!safeName.endsWith('.pdf')) { res.writeHead(404); res.end('Not found'); return; }
    fs.readFile(filePath, (err, data) => {
      if (err) { res.writeHead(404); res.end('PDF não encontrado. Coloca o ficheiro em public/docs/'); return; }
      res.writeHead(200, {
        'Content-Type': 'application/pdf',
        'Content-Disposition': `attachment; filename="${safeName}"`,
      });
      res.end(data);
    });
    return;
  }

  // Everything else: serve client.html
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(CLIENT_HTML);
});

const wss = new WebSocketServer({ server });

wss.on('connection', (ws) => {
  unjoined.add(ws);

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }

    const state = wsState.get(ws);

    switch (msg.type) {

      case 'PING':
        send(ws, { type: 'PONG' });
        break;

      case 'LOBBIES': {
        const list = Object.values(lobbies).map(lobbyView);
        send(ws, { type: 'LOBBIES', lobbies: list });
        break;
      }

      case 'JOIN_LOBBY':
        handleJoin(ws, msg.lobbyId, msg.playerName);
        break;

      case 'LEAVE_LOBBY':
        handleLeave(ws, 'explicit');
        unjoined.add(ws);
        send(ws, { type: 'LEFT' });
        break;

      case 'RECONNECT': {
        const sess = sessions[msg.token];
        if (!sess) { send(ws, { type: 'RECONNECT_FAIL' }); break; }
        const { lobbyId, seat, name } = sess;
        const lobby = lobbies[lobbyId];
        if (!lobby) { send(ws, { type: 'RECONNECT_FAIL' }); break; }

        clearTimeout(lobby.graceTimers[seat]);
        lobby.sockets[seat] = ws;
        lobby.tokens[seat]  = msg.token;
        wsState.set(ws, { lobbyId, seat, token: msg.token });
        unjoined.delete(ws);

        send(ws, { type: 'RECONNECTED', name, lobbyId, seat, isGM: seat === 0 });
        const gstate = buildGameState(lobby, seat);
        send(ws, { type: 'GAME_STATE', state: gstate });
        break;
      }

      // ── GAME ACTIONS ──────────────────────────────────────────────────

      case 'ROLL_DICE': {
        if (!state) break;
        const lobby = lobbies[state.lobbyId];
        if (!lobby || !lobby.game) break;
        const result = rollDice(msg.notation || '1d6');
        if (!result) break;
        result.rolledBy  = lobby.names[state.seat];
        result.seat      = state.seat;
        lobby.game.diceResults[state.seat] = result;
        addLog(lobby, {
          type: 'dice',
          seat: state.seat,
          playerName: lobby.names[state.seat],
          notation: result.notation,
          rolls: result.rolls,
          total: result.total,
        });
        broadcastGameState(lobby);
        break;
      }

      case 'CHAT': {
        if (!state) break;
        const lobby = lobbies[state.lobbyId];
        if (!lobby || !lobby.game) break;
        const text = (msg.text || '').trim().slice(0, 500);
        if (!text) break;
        addChat(lobby, state.seat, lobby.names[state.seat], text, state.seat === 0);
        broadcastGameState(lobby);
        break;
      }

      case 'GM_SCENE': {
        if (!state || state.seat !== 0) break;
        const lobby = lobbies[state.lobbyId];
        if (!lobby || !lobby.game) break;
        const text = (msg.text || '').trim().slice(0, 3000);
        lobby.game.sceneText = text;
        if (text) addLog(lobby, { type: 'scene', content: text, playerName: 'GM' });
        broadcastGameState(lobby);
        break;
      }

      case 'GM_PUSH_MEDIA': {
        if (!state || state.seat !== 0) break;
        const lobby = lobbies[state.lobbyId];
        if (!lobby || !lobby.game) break;
        const mediaType = msg.mediaType === 'video' ? 'video' : 'image';
        const data = (msg.data || '').trim().slice(0, 4000);
        if (!data) break;
        lobby.game.mediaPush = { type: mediaType, data };
        addLog(lobby, { type: mediaType, content: data, playerName: 'GM' });
        broadcastGameState(lobby);
        break;
      }

      case 'GM_CLEAR_MEDIA': {
        if (!state || state.seat !== 0) break;
        const lobby = lobbies[state.lobbyId];
        if (!lobby || !lobby.game) break;
        lobby.game.mediaPush = null;
        broadcastGameState(lobby);
        break;
      }

      case 'PLAYER_ACTION': {
        if (!state) break;
        const lobby = lobbies[state.lobbyId];
        if (!lobby || !lobby.game) break;
        const text = (msg.text || '').trim().slice(0, 300);
        lobby.game.lastAction[state.seat] = text;
        broadcastGameState(lobby);
        break;
      }

      case 'CHARACTER_UPDATE': {
        if (!state) break;
        const lobby = lobbies[state.lobbyId];
        if (!lobby || !lobby.game) break;
        const char = msg.character;
        if (typeof char !== 'object') break;
        // Sanitise
        lobby.game.characters[state.seat] = {
          name:       String(char.name       || '').slice(0, 60),
          background: String(char.background || '').slice(0, 200),
          motivation: String(char.motivation || '').slice(0, 200),
          virtue:     String(char.virtue     || '').slice(0, 200),
          fear:       String(char.fear       || '').slice(0, 200),
          lineage:    String(char.lineage    || '').slice(0, 200),
          skill:      char.skill || { d6: 0, name: '', effect: '' },
          forca:      Math.max(0, Math.min(99, parseInt(char.forca)  || 0)),
          sorte:      Math.max(0, Math.min(20, parseInt(char.sorte)  || 0)),
          musgo:      Math.max(0, Math.min(6,  parseInt(char.musgo)  || 0)),
          xp:         Math.max(0, Math.min(99, parseInt(char.xp)     || 0)),
          notes:      String(char.notes      || '').slice(0, 1000),
        };
        broadcastGameState(lobby);
        break;
      }

      case 'GM_SET_LOCATION': {
        if (!state || state.seat !== 0) break;
        const lobby = lobbies[state.lobbyId];
        if (!lobby || !lobby.game) break;
        lobby.game.location = (msg.text || '').trim().slice(0, 120);
        broadcastGameState(lobby);
        break;
      }

      case 'LOCK_TABLE': {
        if (!state || state.seat !== 0) break;
        const lobby = lobbies[state.lobbyId];
        if (!lobby) break;
        lobby.locked = true;
        addChat(lobby, 0, lobby.names[0], '🔒 Mesa fechada pelo GM — sem novos jogadores.', true);
        broadcastGameState(lobby);
        broadcastLobbies();
        break;
      }

      case 'UNLOCK_TABLE': {
        if (!state || state.seat !== 0) break;
        const lobby = lobbies[state.lobbyId];
        if (!lobby) break;
        lobby.locked = false;
        addChat(lobby, 0, lobby.names[0], '🔓 Mesa aberta pelo GM — podem entrar novos jogadores.', true);
        broadcastGameState(lobby);
        broadcastLobbies();
        break;
      }

      case 'KILL_PLAYER': {
        if (!state || state.seat !== 0) break;
        const lobby = lobbies[state.lobbyId];
        if (!lobby || !lobby.game) break;
        const targetSeat = parseInt(msg.seat);
        const targetName = lobby.names[targetSeat] || '?';
        const charName   = lobby.game.characters[targetSeat]?.name || targetName;
        addLog(lobby, { type: 'kill', content: `${charName} foi abatido.`, playerName: 'GM' });
        addChat(lobby, 0, lobby.names[0], `☠ ${charName} foi abatido. O jogador deve actualizar a sua personagem.`, true);
        broadcastGameState(lobby);
        break;
      }

      case 'SPAWN_NPC': {
        if (!state || state.seat !== 0) break;
        const lobby = lobbies[state.lobbyId];
        if (!lobby || !lobby.game) break;
        const npc = msg.npc || {};
        const uid = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
        const entry = {
          uid,
          name:     String(npc.name     || 'NPC').slice(0, 60),
          faction:  String(npc.faction  || '').slice(0, 60),
          forca:    Math.max(1, Math.min(99, parseInt(npc.forca) || 15)),
          behavior: ['Hostile','Friendly','Fearful','Curious','Neutral'].includes(npc.behavior) ? npc.behavior : 'Neutral',
          notes:    String(npc.notes || '').slice(0, 400),
        };
        lobby.game.npcs.push(entry);
        addLog(lobby, { type: 'scene', content: `[NPC] ${entry.name} entrou em cena. (F:${entry.forca} · ${entry.behavior})`, playerName: 'GM' });
        broadcastGameState(lobby);
        break;
      }

      case 'REMOVE_NPC': {
        if (!state || state.seat !== 0) break;
        const lobby = lobbies[state.lobbyId];
        if (!lobby || !lobby.game) break;
        const uid = msg.uid;
        const npc = lobby.game.npcs.find(n => n.uid === uid);
        if (npc) {
          lobby.game.npcs = lobby.game.npcs.filter(n => n.uid !== uid);
          addLog(lobby, { type: 'scene', content: `[NPC] ${npc.name} saiu de cena.`, playerName: 'GM' });
        }
        broadcastGameState(lobby);
        break;
      }

      case 'REQUEST_STATE': {
        if (!state) break;
        const lobby = lobbies[state.lobbyId];
        if (!lobby || !lobby.game) break;
        send(ws, { type: 'GAME_STATE', state: buildGameState(lobby, state.seat) });
        break;
      }
    }
  });

  ws.on('close', () => {
    unjoined.delete(ws);
    handleLeave(ws, 'disconnect');
  });

  ws.on('error', () => {
    unjoined.delete(ws);
    handleLeave(ws, 'disconnect');
  });

  // Send lobby list on connect
  const list = Object.values(lobbies).map(lobbyView);
  send(ws, { type: 'LOBBIES', lobbies: list });
});

server.listen(PORT, () => {
  console.log(`🌿 Mundo Musgo Online — porta ${PORT}`);
});
