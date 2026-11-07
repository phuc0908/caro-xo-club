import { randomBytes } from 'node:crypto';

const TTL = 86400;
const N = 15;
const directions = [[1, 0], [0, 1], [1, 1], [1, -1]];
const key = code => `caro:v1:${code}`;
const token = () => randomBytes(24).toString('hex');
const roomCode = () => randomBytes(5).toString('hex').slice(0, 6).toUpperCase();

const fail = (message, status = 400) => Object.assign(new Error(message), { status });
const configured = () => Boolean(process.env.UPSTASH_REDIS_REST_URL && process.env.UPSTASH_REDIS_REST_TOKEN);

async function command(...args) {
  if (!configured()) throw fail('Phòng online chưa sẵn sàng: hãy cấu hình Upstash Redis.', 503);
  let response;
  try {
    response = await fetch(process.env.UPSTASH_REDIS_REST_URL.replace(/\/$/, ''), {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${process.env.UPSTASH_REDIS_REST_TOKEN}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(args),
      signal: AbortSignal.timeout(8000),
    });
  } catch { throw fail('Không kết nối được Redis.', 503); }
  if (!response.ok) {
    const error = fail(response.status === 429 ? 'Máy chủ đang bận, vui lòng chờ và thử lại.' : 'Không kết nối được Redis.', response.status === 429 ? 429 : 503);
    error.retryAfter = response.headers.get('Retry-After') || '5';
    throw error;
  }
  const data = await response.json();
  if (data.error) throw fail('Redis: ' + data.error, 503);
  return data.result;
}

// Check the revision inside Redis so unchanged polls do not transfer the board
// from Redis to the function either. A normal GET remains available to old clients.
const READ_IF_CHANGED_LUA = `
local raw=redis.call('GET',KEYS[1])
if not raw then return 0 end
local ok,current=pcall(cjson.decode,raw)
if ok and type(current)=='table' and tonumber(current.revision)==tonumber(ARGV[1]) then return false end
return raw
`;
async function read(code, revision = null) {
  const json = revision === null
    ? await command('GET', key(code))
    : await command('EVAL', READ_IF_CHANGED_LUA, '1', key(code), String(revision));
  if (revision !== null && json === null) return null;
  if (!json) throw fail('Phòng không tồn tại hoặc đã hết hạn', 404);
  try { return JSON.parse(json); } catch { throw fail('Dữ liệu phòng không hợp lệ.', 500); }
}

// Compare-and-set: ensures two simultaneous moves cannot overwrite one another.
const CAS_LUA = `
local raw=redis.call('GET',KEYS[1])
if not raw then return 'MISSING' end
local current=cjson.decode(raw)
if tonumber(current.revision) ~= tonumber(ARGV[1]) then return 'CONFLICT' end
redis.call('SET',KEYS[1],ARGV[2],'EX',tonumber(ARGV[3]))
return 'OK'
`;
async function update(code, prev, next) {
  const result = await command('EVAL', CAS_LUA, '1', key(code), String(prev.revision), JSON.stringify(next), String(TTL));
  if (result === 'MISSING') throw fail('Phòng không tồn tại hoặc đã hết hạn', 404);
  if (result === 'CONFLICT') throw fail('Trạng thái phòng vừa thay đổi, vui lòng thử lại.', 409);
  if (result !== 'OK') throw fail('Không thể lưu trận đấu.', 503);
}

const validName = value => typeof value === 'string' ? value.trim().slice(0, 24) || 'Người chơi' : 'Người chơi';
const validCode = value => {
  const c = String(value || '').trim().toUpperCase();
  if (!/^[A-Z0-9]{6}$/.test(c)) throw fail('Mã phòng phải có 6 ký tự.');
  return c;
};
const validRevision = value => {
  if (value === undefined) return null;
  if (typeof value !== 'string' || !/^(0|[1-9]\d{0,15})$/.test(value) || !Number.isSafeInteger(Number(value))) throw fail('Revision không hợp lệ.');
  return Number(value);
};
const publicGame = game => {
  const { ids, ...safe } = game;
  return safe;
};
function win(board, row, col, side) {
  for (const [dr, dc] of directions) {
    let count = 1;
    for (const s of [-1, 1]) {
      let r = row + dr * s, c = col + dc * s;
      while (r >= 0 && r < N && c >= 0 && c < N && board[r * N + c] === side) {
        count++; r += dr * s; c += dc * s;
      }
    }
    if (count >= 5) return true;
  }
  return false;
}

const send = (res, status, data) => {
  res.statusCode = status;
  res.setHeader('Cache-Control', 'no-store');
  if (data === undefined) return res.end();
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.end(JSON.stringify(data));
};

export default async function handler(req, res) {
  try {
    if (req.method === 'GET') {
      const code = validCode(req.query?.room);
      const game = await read(code, validRevision(req.query?.revision));
      if (game === null) return send(res, 204);
      return send(res, 200, { game: publicGame(game) });
    }
    if (req.method !== 'POST') return send(res, 405, { error: 'Method not allowed' });
    let body = req.body || {};
    if (typeof body === 'string') {
      try { body = JSON.parse(body); } catch { throw fail('JSON không hợp lệ.'); }
    }
    if (!body || typeof body !== 'object') throw fail('Request không hợp lệ.');
    const action = body.action;
    if (action === 'create') {
      const id = token();
      for (let attempt = 0; attempt < 6; attempt++) {
        const code = roomCode();
        const game = {
          code, revision: 1, round: 1, board: Array(N * N).fill(''), moves: [],
          players: { X: { name: validName(body.name) }, O: null },
          ids: { X: id, O: null }, status: 'waiting', turn: 'X', winner: null,
          rematch: [], createdAt: new Date().toISOString(),
        };
        const result = await command('SET', key(code), JSON.stringify(game), 'NX', 'EX', String(TTL));
        if (result === 'OK') return send(res, 200, { id, side: 'X', game: publicGame(game) });
      }
      throw fail('Không tạo được mã phòng mới, hãy thử lại.', 503);
    }
    const code = validCode(body.room);
    const game = await read(code);
    if (action === 'join') {
      if (body.id && game.ids.X === body.id) return send(res, 200, { id: body.id, side: 'X', game: publicGame(game) });
      if (body.id && game.ids.O === body.id) return send(res, 200, { id: body.id, side: 'O', game: publicGame(game) });
      if (game.players.O) throw fail('Phòng đã đủ 2 người. Chỉ thành viên cũ được vào lại.', 409);
      const id = token();
      const next = { ...game, revision: game.revision + 1, players: { ...game.players, O: { name: validName(body.name) } }, ids: { ...game.ids, O: id }, status: 'playing' };
      await update(code, game, next);
      return send(res, 200, { id, side: 'O', game: publicGame(next) });
    }
    const side = game.ids.X === body.id ? 'X' : game.ids.O === body.id ? 'O' : null;
    if (!side) throw fail('Không có quyền thao tác trong phòng này.', 403);
    if (action === 'move') {
      if (game.status !== 'playing') throw fail('Trận đấu chưa sẵn sàng hoặc đã kết thúc.', 409);
      if (game.turn !== side) throw fail('Chưa tới lượt của bạn.', 409);
      const row = body.row, col = body.col;
      if (!Number.isInteger(row) || !Number.isInteger(col) || row < 0 || row >= N || col < 0 || col >= N) throw fail('Tọa độ không hợp lệ.');
      if (game.board[row * N + col]) throw fail('Ô đã được đánh.', 409);
      const board = game.board.slice(); board[row * N + col] = side;
      const moves = game.moves.concat({ row, col, side });
      const winner = win(board, row, col, side) ? side : moves.length === N * N ? 'draw' : null;
      const next = { ...game, revision: game.revision + 1, board, moves, turn: side === 'X' ? 'O' : 'X', winner, status: winner ? 'finished' : 'playing', rematch: [] };
      await update(code, game, next);
      return send(res, 200, { game: publicGame(next) });
    }
    if (action === 'rematch') {
      if (game.status !== 'finished') throw fail('Trận đấu chưa kết thúc.', 409);
      if (!game.players.O) throw fail('Chưa có đủ người chơi.', 409);
      const votes = [...new Set([...(game.rematch || []), side])];
      const both = votes.includes('X') && votes.includes('O');
      const next = both
        ? { ...game, revision: game.revision + 1, round: game.round + 1, board: Array(N * N).fill(''), moves: [], status: 'playing', turn: 'X', winner: null, rematch: [] }
        : { ...game, revision: game.revision + 1, rematch: votes };
      await update(code, game, next);
      return send(res, 200, { game: publicGame(next) });
    }
    throw fail('Action không hỗ trợ.', 400);
  } catch (err) {
    if (err.status === 429 || err.status === 503) res.setHeader('Retry-After', err.retryAfter || '5');
    send(res, err.status || 500, { error: err.status ? err.message : 'Lỗi máy chủ. Vui lòng thử lại.' });
  }
}
