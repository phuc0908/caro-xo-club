import { RoomPoller, retryAfterMs } from './polling.js';

const N = 15;
const $ = id => document.getElementById(id);
const board = $('board');
const levels = { easy: 'Dễ', medium: 'Trung bình', hard: 'Khó' };
const directions = [[1, 0], [0, 1], [1, 1], [1, -1]];
const storage = {
  get(key) { try { return localStorage.getItem(key); } catch { return null; } },
  set(key, value) { try { localStorage.setItem(key, value); } catch {} },
};
let game = null, mode = '', side = '', id = '', room = '', difficulty = 'easy';
let pending = false, live = true, thinking = false, aiDelay, toastTimer;
let session = 0, aiNonce = 0, suggestion = null, practice = null;
let roomPolling = null, roomUnavailable = false;
let boardFocusIndex = 112, audioContext, soundBus;
let soundEnabled = storage.get('caro-sound') === 'on';
const audioSupported = Boolean(window.AudioContext || window.webkitAudioContext);
const reduceMotion = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;
const playerName = () => $('nickname').value.trim().slice(0, 24) || 'Người chơi';
const cells = [];

for (let r = 0; r < N; r++) {
  const row = document.createElement('div');
  row.className = 'board-row';
  row.setAttribute('role', 'row');
  for (let c = 0; c < N; c++) {
    const cell = document.createElement('button');
    cell.type = 'button';
    cell.className = 'cell';
    cell.dataset.index = r * N + c;
    cell.setAttribute('role', 'gridcell');
    cell.setAttribute('aria-rowindex', r + 1);
    cell.setAttribute('aria-colindex', c + 1);
    cell.innerHTML = '<svg class="cell-mark hidden" viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path class="piece-x" d="M4.5 4.5 19.5 19.5M19.5 4.5 4.5 19.5"/><circle class="piece-o" cx="12" cy="12" r="8"/></svg>';
    cell.onclick = () => { unlockAudio(); move(r, c); };
    row.append(cell);
    cells.push(cell);
  }
  board.append(row);
}

function toast(message) {
  $('toast').textContent = message;
  $('toast').classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => $('toast').classList.remove('show'), 3200);
}

function note(message, kind = '') {
  $('notice').textContent = message;
  $('notice').className = 'notice ' + kind;
  toast(message);
}

function unlockAudio() {
  if (!soundEnabled || !audioSupported) return;
  try {
    if (!audioContext) {
      const Audio = window.AudioContext || window.webkitAudioContext;
      audioContext = new Audio();
      soundBus = audioContext.createGain();
      soundBus.gain.value = .12;
      soundBus.connect(audioContext.destination);
    }
    if (audioContext.state === 'suspended') audioContext.resume().catch(() => {});
  } catch { /* A browser may disallow audio; gameplay still works. */ }
}

function playSound(kind) {
  if (!soundEnabled || !audioContext || !soundBus || audioContext.state !== 'running') return;
  const notes = kind === 'win' ? [523.25, 659.25, 783.99] : kind === 'loss' ? [392, 329.63] : [kind === 'o' ? 440 : 587.33];
  try {
    notes.forEach((frequency, index) => {
      const start = audioContext.currentTime + index * .12;
      const oscillator = audioContext.createOscillator();
      const gain = audioContext.createGain();
      oscillator.type = 'sine';
      oscillator.frequency.value = frequency;
      gain.gain.setValueAtTime(0, start);
      gain.gain.linearRampToValueAtTime(.6, start + .008);
      gain.gain.exponentialRampToValueAtTime(.001, start + .16);
      oscillator.connect(gain);
      gain.connect(soundBus);
      oscillator.start(start);
      oscillator.stop(start + .18);
      oscillator.onended = () => { oscillator.disconnect(); gain.disconnect(); };
    });
  } catch {}
}

function updateSoundButton() {
  $('soundToggle').textContent = audioSupported ? 'Âm thanh: ' + (soundEnabled ? 'Bật' : 'Tắt') : 'Âm thanh không khả dụng';
  $('soundToggle').setAttribute('aria-pressed', String(soundEnabled && audioSupported));
  $('soundToggle').disabled = !audioSupported;
}

function stopTimers() {
  roomPolling?.stop();
  clearTimeout(aiDelay);
  aiNonce++;
  thinking = false;
}

function resetSession() {
  stopTimers();
  session++;
  game = null;
  mode = ''; side = ''; id = ''; room = '';
  practice = null; suggestion = null;
  pending = false; live = true; boardFocusIndex = 112;
  roomUnavailable = false;
  $('notice').textContent = '';
}

function win(b, r, c, symbol) {
  return directions.some(([dr, dc]) => {
    let count = 1;
    for (const sign of [-1, 1]) {
      let y = r + sign * dr, x = c + sign * dc;
      while (y >= 0 && y < N && x >= 0 && x < N && b[y * N + x] === symbol) {
        count++; y += sign * dr; x += sign * dc;
      }
    }
    return count >= 5;
  });
}

function winnerLine(g) {
  if (g.status !== 'finished' || !['X', 'O'].includes(g.winner) || !g.moves.length) return [];
  const { row, col } = g.moves.at(-1);
  for (const [dr, dc] of directions) {
    const found = [row * N + col];
    for (const sign of [-1, 1]) {
      let r = row + sign * dr, c = col + sign * dc;
      while (r >= 0 && r < N && c >= 0 && c < N && g.board[r * N + c] === g.winner) {
        found.push(r * N + c); r += sign * dr; c += sign * dc;
      }
    }
    if (found.length >= 5) return found;
  }
  return [];
}

function setGame(next) {
  const previous = game;
  game = next;
  suggestion = null;
  paint();
  if (previous?.status !== 'finished' && next.status === 'finished' && mode !== 'practice') revealRematch();
  if (previous && previous.code === next.code && previous.round === next.round && next.moves.length > previous.moves.length) {
    const last = next.moves.at(-1);
    const cell = cells[last.row * N + last.col];
    cell.classList.remove('new');
    void cell.offsetWidth;
    cell.classList.add('new');
    const ended = previous.status !== 'finished' && next.status === 'finished';
    const lost = mode === 'ai' && next.winner === 'O' || mode === 'online' && next.winner !== side;
    playSound(ended && next.winner !== 'draw' ? lost ? 'loss' : 'win' : last.side.toLowerCase());
  }
  if (previous?.status === 'finished' && next.status === 'playing' && next.round > previous.round) note('Ván mới đã bắt đầu!');
}

function paint() {
  const g = game;
  const ended = g?.status === 'finished';
  const waiting = g?.status === 'waiting';
  const humanTurn = mode === 'online' ? g?.turn === side : mode === 'ai' ? g?.turn === 'X' : true;
  $('welcome').classList.toggle('hidden', Boolean(g));
  $('lobby').classList.toggle('hidden', Boolean(g));
  $('active').classList.toggle('hidden', !g);
  $('coach').classList.toggle('hidden', mode !== 'practice');
  $('hintArea').classList.toggle('hidden', mode === 'online' || ended || Boolean(practice?.completed));
  $('rematchArea').classList.toggle('hidden', !ended || mode === 'practice');
  $('modeTag').textContent = ({ ai: 'Đấu với AI', online: 'Trực tuyến', local: 'Chơi cùng máy', practice: 'Tập chơi' })[mode] || 'Cờ Caro';
  $('count').textContent = practice ? 'Bài ' + (practice.step + 1) + '/3' : g ? 'Ván ' + g.round + ' · ' + g.moves.length + ' nước' : '0 nước';
  $('count').classList.toggle('hidden', !g);
  $('navOnline').classList.toggle('active', mode === 'online');
  $('navAI').classList.toggle('active', mode === 'ai');
  $('navLocal').classList.toggle('active', mode === 'local');
  for (const control of ['quickPlay', 'learnStart', 'help', 'navAI', 'navLocal', 'navOnline', 'create', 'join', 'aiStart', 'localStart']) $(control).disabled = pending;
  $('leave').disabled = pending;
  $('hintButton').disabled = !canUseHint();
  $('hintPlay').classList.toggle('hidden', !suggestion);
  $('hintPlay').disabled = !suggestion || !canUseHint();
  $('hintText').textContent = suggestion?.text || (!g ? 'Bắt đầu ván AI hoặc Cùng máy để xem gợi ý nước đi.' : thinking ? 'Chờ AI đánh xong để xem gợi ý cho lượt tiếp theo.' : `Xem nước đi đề xuất cho quân ${g.turn} và lý do chọn ô đó.`);

  if (!g) {
    $('status').textContent = 'Bắt đầu ván cờ';
    $('detail').textContent = 'Đấu AI ở mức Dễ.';
    $('turnPill').textContent = 'X đi trước · Nối 5 quân để thắng';
    $('turnPill').className = 'turn-pill';
    $('controlTitle').textContent = 'Chế độ chơi';
    $('controlHelp').textContent = 'Chơi với AI hoặc mời bạn bè tham gia.';
  } else {
    $('controlTitle').textContent = mode === 'practice' ? 'Làm quen với bàn cờ' : 'Trận đấu của bạn';
    $('controlHelp').textContent = mode === 'practice' ? 'Ba bài tập ngắn. Bạn có thể bỏ qua bất cứ lúc nào.' : 'Mỗi lượt đặt một quân. X luôn đi trước.';
    $('room').textContent = mode === 'online' ? room : mode === 'ai' ? 'AI · ' + levels[difficulty] : mode === 'practice' ? 'Tập chơi' : 'Chơi cùng máy';
    $('room').classList.toggle('is-code', mode === 'online');
    $('roomTitle').textContent = mode === 'online' ? 'Mã phòng' : 'Chế độ chơi';
    $('connection').textContent = mode === 'online' ? roomUnavailable ? 'Phòng không khả dụng' : live ? 'Đã kết nối' : 'Đang kết nối lại…' : mode === 'ai' ? 'Bạn cầm X · AI cầm O' : 'Chơi trên thiết bị này';
    $('invite').classList.toggle('hidden', mode !== 'online');
    $('px').textContent = g.players.X?.name || 'Đang chờ';
    $('po').textContent = g.players.O?.name || 'Đang chờ';
    $('cardX').classList.toggle('mine', ['ai', 'practice'].includes(mode) || mode === 'online' && side === 'X');
    $('cardO').classList.toggle('mine', mode === 'online' && side === 'O');
    $('turnX').textContent = g.status === 'playing' && g.turn === 'X' ? 'Đang đến lượt' : '';
    $('turnO').textContent = g.status === 'playing' && g.turn === 'O' ? 'Đang đến lượt' : '';
    $('aiInfo').classList.toggle('hidden', mode !== 'ai');
    $('aiInfo').textContent = 'AI ' + levels[difficulty] + (thinking ? ' đang suy nghĩ…' : ' · Có gợi ý khi đến lượt bạn.');
    if (waiting) {
      $('status').textContent = 'Đang đợi bạn bè';
      $('detail').textContent = 'Gửi link mời hoặc mã phòng cho người thứ hai.';
    } else if (ended) {
      $('status').textContent = g.winner === 'draw' ? 'Ván đấu hòa' : mode === 'ai' ? g.winner === 'X' ? 'Bạn chiến thắng' : 'AI chiến thắng' : g.winner + ' chiến thắng';
      $('detail').textContent = g.winner === 'draw' ? 'Bàn cờ đã kín. Bạn có thể bắt đầu ván mới.' : mode === 'ai' && g.winner === 'O' ? 'Bạn có thể chơi lại và sử dụng gợi ý để luyện tập.' : 'Các quân tạo thành hàng thắng đã được đánh dấu.';
    } else {
      $('status').textContent = mode === 'ai' ? g.turn === 'X' ? 'Đến lượt bạn' : 'AI đang suy nghĩ…' : mode === 'online' ? humanTurn ? 'Đến lượt bạn' : 'Đến lượt đối thủ' : 'Đến lượt ' + g.turn;
      $('detail').textContent = mode === 'ai' ? g.turn === 'X' ? 'Chạm một ô trống để đặt quân X.' : 'Bạn có thể xem lại thế cờ trong lúc đợi.' : mode === 'online' ? humanTurn ? 'Bạn cầm quân ' + side + '. Chọn một ô trống.' : 'Đang chờ nước đi của người chơi còn lại.' : 'Hai người luân phiên đặt X và O.';
    }
    $('turnPill').textContent = ended ? 'Ván đấu kết thúc' : waiting ? 'Chờ người thứ hai' : !humanTurn ? 'Chờ lượt tiếp theo' : mode === 'local' ? g.turn + ' đang đi' : 'Bạn đang đi quân ' + (side || 'X');
    $('turnPill').className = 'turn-pill' + (ended || waiting || !humanTurn ? ' wait' : '');
    if (mode === 'practice') renderPractice();
    if (ended && mode !== 'practice') renderRematch();
    if (mode === 'online' && roomUnavailable) {
      $('status').textContent = 'Phòng không khả dụng';
      $('detail').textContent = 'Vui lòng tạo hoặc tham gia phòng khác.';
      $('turnPill').textContent = 'Đã dừng cập nhật';
      $('turnPill').className = 'turn-pill wait';
    }
  }

  const wins = new Set(g ? winnerLine(g) : []);
  const last = g?.moves.at(-1);
  cells.forEach((cell, index) => {
    const symbol = g?.board[index] || '';
    const suggested = suggestion?.index === index;
    cell.dataset.symbol = symbol;
    cell.firstElementChild.classList.toggle('hidden', !symbol && !suggested);
    cell.classList.toggle('o', (symbol || (suggested ? g.turn : '')) === 'O');
    cell.classList.toggle('last', Boolean(last && last.row * N + last.col === index));
    cell.classList.toggle('win', wins.has(index));
    cell.classList.toggle('suggested', suggested);
    cell.classList.toggle('lesson-target', Boolean(practice && !practice.completed && practiceTarget() === index));
    cell.disabled = !g || Boolean(symbol) || g.status !== 'playing' || pending || !humanTurn || thinking || Boolean(practice?.completed) || mode === 'online' && roomUnavailable;
    cell.setAttribute('aria-label', `Hàng ${Math.floor(index / N) + 1}, cột ${index % N + 1}: ${symbol || 'ô trống'}${suggested ? ', nước đi gợi ý cho ' + g.turn : ''}`);
  });
  if (cells[boardFocusIndex].disabled) boardFocusIndex = cells[112].disabled ? cells.findIndex(cell => !cell.disabled) : 112;
  if (boardFocusIndex < 0) boardFocusIndex = 112;
  cells.forEach((cell, index) => { cell.tabIndex = !cell.disabled && index === boardFocusIndex ? 0 : -1; });
}

function renderRematch() {
  const votes = game.rematch || [];
  if (mode !== 'online') {
    $('rematchTitle').textContent = 'Ván đấu đã kết thúc';
    $('rematchInfo').textContent = 'Bắt đầu lại với bàn cờ mới. Bạn có thể dùng gợi ý để thử một cách đánh khác.';
    if (mode === 'local') $('rematchInfo').textContent = 'Bắt đầu lại với bàn cờ mới. X tiếp tục đi trước.';
    $('rematch').textContent = 'Chơi lại';
    $('rematch').disabled = pending;
  } else {
    const requested = votes.includes(side);
    $('rematchTitle').textContent = requested ? 'Đã gửi lời mời tái đấu' : votes.length ? 'Đối thủ đề nghị tái đấu' : 'Ván đấu đã kết thúc';
    $('rematchInfo').textContent = requested ? 'Đang chờ đối thủ xác nhận.' : 'Cả hai người chơi cần đồng ý để bắt đầu ván mới.';
    $('rematch').textContent = requested ? 'Đang chờ đối thủ' : votes.length ? 'Đồng ý tái đấu' : 'Mời tái đấu';
    $('rematch').disabled = requested || pending || roomUnavailable;
  }
}

function newLocal(round = 1) {
  return { board: Array(N * N).fill(''), moves: [], players: { X: { name: playerName() }, O: { name: mode === 'ai' ? 'AI · ' + levels[difficulty] : mode === 'practice' ? 'Bài tập' : 'Người chơi O' } }, turn: 'X', status: 'playing', winner: null, rematch: [], round };
}

function localMove(r, c, symbol) {
  if (!game || game.board[r * N + c] || game.status !== 'playing' || game.turn !== symbol) return false;
  const b = game.board.slice();
  b[r * N + c] = symbol;
  const moves = game.moves.concat({ row: r, col: c, side: symbol });
  const winner = win(b, r, c, symbol) ? symbol : moves.length === N * N ? 'draw' : null;
  setGame({ ...game, board: b, moves, turn: symbol === 'X' ? 'O' : 'X', status: winner ? 'finished' : 'playing', winner });
  return true;
}

function chooseCandidates(b) {
  if (!b.some(Boolean)) return [{ r: 7, c: 7 }];
  const positions = new Set();
  for (let i = 0; i < N * N; i++) if (b[i]) {
    const r = Math.floor(i / N), c = i % N;
    for (let dr = -2; dr <= 2; dr++) for (let dc = -2; dc <= 2; dc++) {
      const rr = r + dr, cc = c + dc;
      if (rr >= 0 && rr < N && cc >= 0 && cc < N && !b[rr * N + cc]) positions.add(rr * N + cc);
    }
  }
  return [...positions].map(i => ({ r: Math.floor(i / N), c: i % N }));
}

function evaluate(b, r, c, symbol) {
  const enemy = symbol === 'O' ? 'X' : 'O', weight = [0, 2, 14, 95, 850, 300000];
  let total = 0;
  for (const [dr, dc] of directions) {
    let count = 1, open = 0;
    for (const sign of [-1, 1]) {
      let rr = r + dr * sign, cc = c + dc * sign;
      while (rr >= 0 && rr < N && cc >= 0 && cc < N && b[rr * N + cc] === symbol) { count++; rr += dr * sign; cc += dc * sign; }
      if (rr >= 0 && rr < N && cc >= 0 && cc < N && b[rr * N + cc] !== enemy) open++;
    }
    if (count >= 5) return 10000000;
    let score = weight[Math.min(count, 5)];
    if (open === 2) score *= count === 4 ? 10 : 3;
    else if (open === 0) score *= .02;
    total += score;
  }
  return total;
}

function rankMoves(b, symbol) {
  const enemy = symbol === 'O' ? 'X' : 'O';
  return chooseCandidates(b).map(({ r, c }) => {
    const i = r * N + c;
    b[i] = symbol;
    const instant = win(b, r, c, symbol), attack = evaluate(b, r, c, symbol);
    b[i] = enemy;
    const block = win(b, r, c, enemy), defense = evaluate(b, r, c, enemy);
    b[i] = '';
    return { r, c, attack, defense, instant, block, score: instant ? 1e9 : block ? 7e8 : attack + .94 * defense + Math.random() * .001 };
  }).sort((a, b) => b.score - a.score);
}

function chooseAI(b) {
  const ranked = rankMoves(b, 'O');
  if (!ranked.length) return null;
  if (difficulty === 'easy') return ranked[Math.floor(Math.random() * Math.min(12, ranked.length))];
  if (ranked[0].instant || ranked[0].block) return ranked[0];
  if (difficulty === 'medium') return Math.random() < .8 ? ranked[0] : ranked[Math.floor(Math.random() * Math.min(3, ranked.length))];
  let best = ranked[0], max = -Infinity;
  for (const candidate of ranked.slice(0, 9)) {
    const i = candidate.r * N + candidate.c;
    b[i] = 'O';
    const reply = rankMoves(b, 'X')[0];
    const value = candidate.attack * 1.25 + candidate.defense * .75 - (reply ? reply.instant ? 1e8 : reply.block ? 12000 : reply.attack * .9 + reply.defense * .25 : 0);
    b[i] = '';
    if (value > max) { max = value; best = candidate; }
  }
  return best;
}

function canUseHint() {
  return Boolean(game?.status === 'playing' && ['ai', 'local', 'practice'].includes(mode) && !pending && !thinking && !practice?.completed && (mode !== 'ai' || game.turn === 'X'));
}

function showHint() {
  if (!canUseHint()) return;
  const symbol = game.turn;
  const best = rankMoves(game.board.slice(), symbol)[0];
  if (!best) return;
  const coordinate = `hàng ${best.r + 1}, cột ${best.c + 1}`;
  const reason = !game.moves.length ? 'Bắt đầu gần giữa bàn để có nhiều hướng phát triển.' : best.instant ? `Nước này nối đủ 5 quân ${symbol} và giúp bạn thắng.` : best.block ? 'Chặn ô này để đối thủ không nối được 5 quân ở lượt tới.' : best.defense > best.attack ? 'Ô này giúp cản hướng phát triển của đối thủ.' : `Ô này giúp mở rộng thế tấn công từ những quân ${symbol} đã có.`;
  suggestion = { index: best.r * N + best.c, text: `Gợi ý cho ${symbol}: ${coordinate}. ${reason}` };
  paint();
  if ($('boardViewport').classList.contains('zoomed')) revealCell(suggestion.index);
}

function queueAI() {
  if (mode !== 'ai' || game?.turn !== 'O' || game?.status !== 'playing') return;
  const nonce = ++aiNonce;
  thinking = true;
  paint();
  aiDelay = setTimeout(() => {
    if (nonce !== aiNonce || mode !== 'ai' || game?.turn !== 'O' || game?.status !== 'playing') return;
    try { const candidate = chooseAI(game.board.slice()); if (candidate) localMove(candidate.r, candidate.c, 'O'); }
    finally { thinking = false; paint(); }
  }, difficulty === 'hard' ? 650 : difficulty === 'medium' ? 450 : 320);
}

async function move(r, c) {
  if (!game || pending || thinking || game.status !== 'playing' || game.board[r * N + c]) return;
  if (mode === 'practice') { practiceMove(r, c); return; }
  if (mode === 'ai') {
    if (game.turn === 'X' && localMove(r, c, 'X') && game.status === 'playing') queueAI();
    return;
  }
  if (mode === 'local') { localMove(r, c, game.turn); return; }
  if (game.turn !== side) return;
  if (roomUnavailable) return;
  const current = session;
  let refreshError = null;
  pending = true;
  roomPolling.pause();
  paint();
  try { const result = await api({ action: 'move', room, id, row: r, col: c }); if (current === session) setGame(result.game); }
  catch (error) { if (current === session) { note(error.message, 'warn'); refreshError = error; } }
  finally {
    if (current === session) {
      pending = false;
      paint();
      if (refreshError) refresh(refreshError);
      else schedule();
    }
  }
}

function canReplaceGame() {
  return !game || game.status === 'finished' || confirm('Rời trận hiện tại để bắt đầu chế độ khác?');
}

function focusBoard() {
  if (window.innerWidth <= 700) $('boardCard').scrollIntoView({ behavior: reduceMotion() ? 'auto' : 'smooth', block: 'start' });
}

function revealRematch() {
  requestAnimationFrame(() => {
    if (game?.status !== 'finished' || mode === 'practice') return;
    const area = $('rematchArea');
    const bounds = area.getBoundingClientRect();
    if (bounds.top < 16 || bounds.bottom > window.innerHeight - 16) {
      area.scrollIntoView({ behavior: reduceMotion() ? 'auto' : 'smooth', block: 'nearest' });
    }
  });
}

function startAI(level = 'easy', check = true) {
  if (pending || check && !canReplaceGame()) return;
  unlockAudio();
  closeModal();
  resetSession();
  mode = 'ai'; side = 'X'; difficulty = level;
  history.replaceState(null, '', location.pathname);
  setGame(newLocal());
  note('Bạn đi trước. Chạm một ô trống để bắt đầu.');
  focusBoard();
}

function localStart() {
  if (pending || !canReplaceGame()) return;
  unlockAudio();
  resetSession();
  mode = 'local';
  history.replaceState(null, '', location.pathname);
  setGame(newLocal());
  note('X đi trước. Hai người luân phiên đặt quân.');
  focusBoard();
}

// Each lesson teaches one action on a small, deterministic board position.
const lessons = [
  { title: 'Đặt quân đầu tiên', text: 'Bạn cầm X. Chạm một ô trống để đặt quân. Ô giữa bàn là một cách bắt đầu.', target: 112, pieces: [], success: 'Bạn đã đặt quân X. Trong một ván thật, tiếp theo sẽ là lượt O.' },
  { title: 'Nối 5 quân để thắng', text: 'Bạn đã có 4 quân X liền nhau. Đặt thêm một quân vào ô được viền để hoàn thành hàng 5.', target: 112, pieces: [[7, 2, 'O'], [7, 3, 'X'], [7, 4, 'X'], [7, 5, 'X'], [7, 6, 'X']], success: 'Đủ 5 quân liên tiếp! Bạn cũng có thể thắng theo hàng dọc hoặc đường chéo.' },
  { title: 'Chặn nước thắng của đối thủ', text: 'O đang có 4 quân liền nhau. Đặt X vào ô được viền để chặn đầu còn lại.', target: 113, pieces: [[7, 3, 'X'], [7, 4, 'O'], [7, 5, 'O'], [7, 6, 'O'], [7, 7, 'O']], success: 'Bạn đã chặn được O. Giờ bạn đã sẵn sàng thử một ván với AI Dễ.' },
];

const practiceTarget = () => lessons[practice.step].target;

function startPractice() {
  if (pending || !canReplaceGame()) return;
  unlockAudio();
  closeModal();
  resetSession();
  mode = 'practice'; side = 'X';
  history.replaceState(null, '', location.pathname);
  loadLesson(0);
  note('Thử ba bài tập ngắn. Bạn có thể bỏ qua bất cứ lúc nào.');
  focusBoard();
}

function loadLesson(step) {
  practice = { step, completed: false };
  game = null;
  const next = newLocal();
  for (const [r, c, symbol] of lessons[step].pieces) {
    next.board[r * N + c] = symbol;
    next.moves.push({ row: r, col: c, side: symbol });
  }
  boardFocusIndex = lessons[step].target;
  setGame(next);
  if ($('boardViewport').classList.contains('zoomed')) requestAnimationFrame(() => revealCell(boardFocusIndex));
}

function renderPractice() {
  const lesson = lessons[practice.step];
  $('coachStep').textContent = `Bài ${practice.step + 1}/3`;
  $('coachTitle').textContent = practice.completed ? 'Hoàn thành bài tập' : lesson.title;
  $('coachText').textContent = practice.completed ? lesson.success : lesson.text;
  $('coachNext').classList.toggle('hidden', !practice.completed);
  $('coachNext').textContent = practice.step === 2 ? 'Chơi một ván AI Dễ' : 'Tiếp: ' + lessons[practice.step + 1].title.toLowerCase();
  $('status').textContent = practice.completed ? 'Bạn đã hoàn thành bài ' + (practice.step + 1) : lesson.title;
  $('detail').textContent = practice.completed ? 'Tiếp tục khi bạn đã sẵn sàng.' : 'Thử trực tiếp trên bàn cờ bên dưới.';
  $('turnPill').textContent = practice.completed ? 'Đã hoàn thành' : 'Bạn đang đi quân X';
  $('turnPill').className = 'turn-pill';
  $('turnX').textContent = practice.completed ? '' : 'Đang đến lượt';
  $('turnO').textContent = '';
}

function practiceMove(r, c) {
  if (!practice || practice.completed) return;
  if (practice.step > 0 && r * N + c !== practiceTarget()) {
    toast(practice.step === 1 ? 'Thử ô được viền để nối đủ 5 quân X.' : 'Thử ô được viền để chặn hàng O.');
    return;
  }
  if (localMove(r, c, 'X')) {
    practice.completed = true;
    paint();
    $('coachNext').focus({ preventScroll: true });
  }
}

async function api(data) {
  const response = await fetch('/api/game', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data), cache: 'no-store' });
  let json;
  try { json = await response.json(); } catch { throw Error('Phản hồi máy chủ không hợp lệ.'); }
  if (!response.ok) throw Object.assign(Error(json.error || 'Không thể kết nối máy chủ.'), { status: response.status, retryAfterMs: retryAfterMs(response.headers.get('Retry-After')) });
  return json;
}

function schedule() {
  roomPolling.sync({ reset: true });
}

function refresh(error) {
  roomPolling.sync({ immediate: true, force: true, retryAfter: error?.retryAfterMs || 0 });
}

roomPolling = new RoomPoller({
  getState: () => mode === 'online' && game ? {
    session, room, revision: game.revision, status: game.status, turn: game.turn,
    side, rematch: game.rematch, visible: !document.hidden, online: navigator.onLine !== false, busy: pending,
  } : null,
  load: async (state, signal) => {
    const params = new URLSearchParams({ room: state.room, revision: state.revision });
    const response = await fetch('/api/game?' + params, { cache: 'no-store', signal });
    if (response.status === 204) return {};
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw Object.assign(Error(data.error || 'Không thể cập nhật phòng.'), { status: response.status, retryAfterMs: retryAfterMs(response.headers.get('Retry-After')) });
    if (!data.game || !Number.isSafeInteger(data.game.revision) || data.game.code !== state.room) throw Error('Dữ liệu phòng không hợp lệ.');
    return data;
  },
  onData: data => {
    const recovered = !live;
    live = true;
    if (data.game && (!game || data.game.revision > game.revision)) setGame(data.game);
    else if (recovered) paint();
  },
  onError: (error, { terminal }) => {
    const changed = live || terminal;
    live = false;
    roomUnavailable = terminal;
    if (changed) paint();
    if (terminal) note(error.message, 'warn');
  },
});

async function create() {
  if (pending) return;
  unlockAudio();
  pending = true;
  paint();
  try {
    const result = await api({ action: 'create', name: playerName() });
    resetSession();
    mode = 'online'; side = result.side; id = result.id; room = result.game.code;
    storage.set('caro-key-' + room, id);
    history.replaceState(null, '', '?room=' + room);
    setGame(result.game);
    note('Đã tạo phòng. Gửi link mời cho bạn bè!');
    focusBoard();
  } catch (error) { toast(error.message); }
  finally { pending = false; paint(); schedule(); }
}

async function join(code) {
  if (pending) return false;
  code = String(code || '').trim().toUpperCase();
  if (!/^[A-Z0-9]{6}$/.test(code)) { toast('Mã phòng phải gồm đúng 6 ký tự.'); return false; }
  unlockAudio();
  pending = true;
  paint();
  let success = false;
  try {
    const result = await api({ action: 'join', room: code, name: playerName(), id: storage.get('caro-key-' + code) || '' });
    resetSession();
    mode = 'online'; side = result.side; id = result.id; room = result.game.code;
    storage.set('caro-key-' + room, id);
    history.replaceState(null, '', '?room=' + room);
    setGame(result.game);
    note('Đã vào phòng! Bạn cầm quân ' + side + '.');
    focusBoard();
    success = true;
  } catch (error) { toast(error.message); }
  finally { pending = false; paint(); schedule(); }
  return success;
}

async function rematch() {
  if (pending || !game || game.status !== 'finished' || mode === 'online' && roomUnavailable) return;
  unlockAudio();
  if (mode !== 'online') {
    stopTimers();
    setGame(newLocal(game.round + 1));
    note('Ván mới bắt đầu. X đi trước!');
    focusBoard();
    return;
  }
  const current = session;
  let refreshError = null;
  pending = true;
  roomPolling.pause();
  paint();
  try {
    const result = await api({ action: 'rematch', room, id });
    if (current === session) { setGame(result.game); note(result.game.status === 'finished' ? 'Đã mời tái đấu. Chờ đối thủ xác nhận.' : 'Ván mới bắt đầu!'); }
  } catch (error) { if (current === session) { note(error.message, 'warn'); refreshError = error; } }
  finally {
    if (current === session) {
      pending = false;
      paint();
      if (refreshError) refresh(refreshError);
      else schedule();
    }
  }
}

function lobby() {
  resetSession();
  history.replaceState(null, '', location.pathname);
  $('code').value = '';
  paint();
}

let modalReturnFocus = null;
function closeModal() {
  $('modalRoot').replaceChildren();
  document.body.style.overflow = '';
  if (modalReturnFocus?.isConnected) modalReturnFocus.focus({ preventScroll: true });
  modalReturnFocus = null;
}

function popup(inner) {
  closeModal();
  modalReturnFocus = document.activeElement;
  const overlay = document.createElement('div');
  overlay.className = 'overlay';
  const panel = document.createElement('div');
  panel.className = 'dialog';
  panel.setAttribute('role', 'dialog');
  panel.setAttribute('aria-modal', 'true');
  panel.setAttribute('aria-labelledby', 'modalTitle');
  panel.innerHTML = inner;
  overlay.append(panel);
  $('modalRoot').append(overlay);
  document.body.style.overflow = 'hidden';
  overlay.onclick = event => { if (event.target === overlay) closeModal(); };
  overlay.addEventListener('keydown', event => {
    if (event.key === 'Escape') closeModal();
    if (event.key !== 'Tab') return;
    const focusable = [...panel.querySelectorAll('button:not(:disabled), input:not(:disabled)')];
    const first = focusable[0], last = focusable.at(-1);
    if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
  });
  return panel;
}

function aiOptions() {
  if (pending) return;
  const panel = popup('<h2 id="modalTitle">Đấu với AI</h2><p>Chọn thử thách phù hợp. Bạn cầm X và được đi trước.</p><label class="label" for="aiName">Tên hiển thị <span class="optional">(tùy chọn)</span></label><input class="input" maxlength="24" id="aiName" placeholder="Người chơi" autocomplete="nickname"><div class="label" id="difficultyLabel">Độ khó</div><div class="levels" role="group" aria-labelledby="difficultyLabel"><button class="level" data-d="easy"><b>Dễ</b><small>Làm quen</small></button><button class="level" data-d="medium"><b>Trung bình</b><small>Thử sức</small></button><button class="level" data-d="hard"><b>Khó</b><small>Nâng cao</small></button></div><div class="dialog-actions"><button class="btn secondary" id="aiCancel">Hủy</button><button class="btn" id="aiGo">Bắt đầu</button></div>');
  const input = panel.querySelector('#aiName');
  input.value = playerName() === 'Người chơi' ? '' : playerName();
  let selected = difficulty;
  const update = () => panel.querySelectorAll('.level').forEach(button => button.setAttribute('aria-pressed', String(button.dataset.d === selected)));
  update();
  panel.querySelectorAll('.level').forEach(button => { button.onclick = () => { selected = button.dataset.d; update(); }; });
  panel.querySelector('#aiCancel').onclick = closeModal;
  panel.querySelector('#aiGo').onclick = () => {
    if (!canReplaceGame()) return;
    $('nickname').value = input.value.trim();
    storage.set('caro-name', $('nickname').value);
    startAI(selected, false);
  };
  input.onkeydown = event => { if (event.key === 'Enter') panel.querySelector('#aiGo').click(); };
  panel.querySelector('.level[aria-pressed="true"]').focus();
}

function invitation(code) {
  const panel = popup('<h2 id="modalTitle">Bạn nhận được lời mời chơi</h2><p id="inviteDescription">Một người bạn đang mời bạn tham gia trận Caro.</p><div class="modal-code"><span>Mã phòng</span><strong id="inviteCode"></strong></div><label class="label" for="inviteName">Tên hiển thị <span class="optional">(tùy chọn)</span></label><input class="input" id="inviteName" maxlength="24" autocomplete="nickname" placeholder="Người chơi"><div class="dialog-actions"><button class="btn secondary" id="decline">Từ chối</button><button class="btn" id="accept" disabled>Vào phòng</button></div><div class="hint" id="inviteFeedback" role="status">Đang kiểm tra phòng…</div>');
  panel.querySelector('#inviteCode').textContent = code;
  const input = panel.querySelector('#inviteName');
  input.value = playerName() === 'Người chơi' ? '' : playerName();
  const feedback = panel.querySelector('#inviteFeedback'), accept = panel.querySelector('#accept');
  panel.querySelector('#decline').onclick = () => { closeModal(); history.replaceState(null, '', location.pathname); };
  fetch('/api/game?room=' + encodeURIComponent(code), { cache: 'no-store' }).then(async response => {
    const data = await response.json();
    if (!panel.isConnected) return;
    if (!response.ok) throw Error(data.error || 'Phòng không tồn tại');
    if (data.game.players.X?.name) panel.querySelector('#inviteDescription').textContent = data.game.players.X.name + ' đang mời bạn vào chơi Caro!';
    feedback.textContent = data.game.status === 'waiting' ? 'Phòng đang đợi người chơi thứ hai.' : 'Người từng tham gia có thể vào lại phòng này.';
    accept.disabled = false;
  }).catch(error => { if (panel.isConnected) { feedback.textContent = error.message; accept.disabled = true; } });
  accept.onclick = async () => {
    accept.disabled = true;
    $('nickname').value = input.value.trim();
    storage.set('caro-name', $('nickname').value);
    if (await join(code)) closeModal();
    else if (panel.isConnected) { accept.disabled = false; feedback.textContent = 'Chưa thể tham gia phòng. Vui lòng kiểm tra và thử lại.'; }
  };
  input.onkeydown = event => { if (event.key === 'Enter') accept.click(); };
  input.focus();
}

function revealCell(index) {
  const viewport = $('boardViewport'), cell = cells[index];
  viewport.scrollTo({ left: cell.offsetLeft - viewport.clientWidth / 2 + cell.offsetWidth / 2, top: cell.offsetTop - viewport.clientHeight / 2 + cell.offsetHeight / 2, behavior: reduceMotion() ? 'auto' : 'smooth' });
}

// Native touch and wheel scrolling stay enabled. Mouse dragging only pans a
// board that actually overflows; finishing a drag must never place a piece.
const boardViewport = $('boardViewport');
let boardDrag = null, suppressBoardClick = false;
boardViewport.addEventListener('pointerdown', event => {
  if (event.pointerType !== 'mouse' || event.button !== 0) return;
  if (boardViewport.scrollWidth <= boardViewport.clientWidth && boardViewport.scrollHeight <= boardViewport.clientHeight) return;
  boardDrag = { pointerId: event.pointerId, x: event.clientX, y: event.clientY, left: boardViewport.scrollLeft, top: boardViewport.scrollTop, moved: false };
});
boardViewport.addEventListener('pointermove', event => {
  if (!boardDrag || event.pointerId !== boardDrag.pointerId) return;
  const dx = event.clientX - boardDrag.x, dy = event.clientY - boardDrag.y;
  if (!boardDrag.moved && Math.hypot(dx, dy) < 5) return;
  if (!boardDrag.moved) {
    boardDrag.moved = true;
    boardViewport.setPointerCapture(event.pointerId);
    boardViewport.classList.add('dragging');
  }
  boardViewport.scrollLeft = boardDrag.left - dx;
  boardViewport.scrollTop = boardDrag.top - dy;
  event.preventDefault();
});
function endBoardDrag(event) {
  if (!boardDrag || event.pointerId !== boardDrag.pointerId) return;
  if (boardDrag.moved) {
    suppressBoardClick = true;
    setTimeout(() => { suppressBoardClick = false; }, 0);
  }
  boardDrag = null;
  boardViewport.classList.remove('dragging');
  if (boardViewport.hasPointerCapture(event.pointerId)) boardViewport.releasePointerCapture(event.pointerId);
}
boardViewport.addEventListener('pointerup', endBoardDrag);
boardViewport.addEventListener('pointercancel', endBoardDrag);
boardViewport.addEventListener('lostpointercapture', endBoardDrag);
boardViewport.addEventListener('pointerleave', event => { if (boardDrag && !boardDrag.moved) endBoardDrag(event); });
boardViewport.addEventListener('click', event => {
  if (!suppressBoardClick) return;
  event.preventDefault();
  event.stopImmediatePropagation();
  suppressBoardClick = false;
}, true);

board.addEventListener('focusin', event => {
  if (!event.target.matches('.cell')) return;
  boardFocusIndex = Number(event.target.dataset.index);
  cells.forEach((cell, index) => { cell.tabIndex = !cell.disabled && index === boardFocusIndex ? 0 : -1; });
});
board.addEventListener('keydown', event => {
  if (!event.target.matches('.cell')) return;
  const offsets = { ArrowLeft: [0, -1], ArrowRight: [0, 1], ArrowUp: [-1, 0], ArrowDown: [1, 0] };
  if (!offsets[event.key]) return;
  event.preventDefault();
  const [dr, dc] = offsets[event.key];
  let r = Math.floor(boardFocusIndex / N) + dr, c = boardFocusIndex % N + dc;
  while (r >= 0 && r < N && c >= 0 && c < N) {
    const cell = cells[r * N + c];
    if (!cell.disabled) { cell.focus({ preventScroll: true }); if ($('boardViewport').classList.contains('zoomed')) revealCell(r * N + c); return; }
    r += dr; c += dc;
  }
});

$('nickname').value = storage.get('caro-name') || '';
$('nickname').addEventListener('change', () => storage.set('caro-name', $('nickname').value));
$('quickPlay').onclick = () => startAI('easy');
$('learnStart').onclick = startPractice;
$('help').onclick = startPractice;
$('coachSkip').onclick = () => startAI('easy', false);
$('coachNext').onclick = () => { if (!practice?.completed) return; if (practice.step === 2) startAI('easy', false); else loadLesson(practice.step + 1); };
$('hintButton').onclick = showHint;
$('hintPlay').onclick = () => {
  if (!canUseHint() || !suggestion || game.board[suggestion.index]) return;
  const index = suggestion.index;
  unlockAudio();
  move(Math.floor(index / N), index % N);
};
$('soundToggle').onclick = () => {
  soundEnabled = !soundEnabled;
  storage.set('caro-sound', soundEnabled ? 'on' : 'off');
  unlockAudio();
  if (soundBus) soundBus.gain.setValueAtTime(soundEnabled ? .12 : 0, audioContext.currentTime);
  updateSoundButton();
  if (soundEnabled) playSound('x');
};
$('zoomToggle').onclick = () => {
  const zoomed = $('boardViewport').classList.toggle('zoomed');
  $('zoomToggle').setAttribute('aria-pressed', String(zoomed));
  $('zoomToggle').textContent = zoomed ? 'Thu gọn bàn cờ' : 'Phóng to bàn cờ';
  $('boardNote').textContent = zoomed ? 'Kéo để di chuyển bàn cờ.' : 'Nối 5 quân để thắng.';
  if (zoomed) requestAnimationFrame(() => revealCell(suggestion?.index ?? (practice && !practice.completed ? practiceTarget() : game?.moves.length ? game.moves.at(-1).row * N + game.moves.at(-1).col : 112)));
};
$('create').onclick = create;
$('join').onclick = () => join($('code').value);
$('aiStart').onclick = aiOptions;
$('localStart').onclick = localStart;
$('navAI').onclick = aiOptions;
$('navLocal').onclick = localStart;
$('navOnline').onclick = () => { if (!game || canReplaceGame()) { lobby(); $('create').focus(); } };
$('leave').onclick = () => { if (!pending && (!game || game.status === 'finished' || confirm('Rời trận hiện tại? Bạn có thể vào lại phòng online bằng mã phòng hoặc link mời.'))) { lobby(); $('quickPlay').focus(); } };
$('rematch').onclick = rematch;
$('invite').onclick = async () => {
  if (mode !== 'online') return;
  const link = new URL(location.pathname, location.origin);
  link.searchParams.set('room', room);
  try { await navigator.clipboard.writeText(link.href); note('Đã sao chép link mời.'); }
  catch { prompt('Sao chép link mời:', link.href); }
};
$('code').addEventListener('input', event => { event.target.value = event.target.value.toUpperCase().replace(/[^A-Z0-9]/g, ''); });
$('code').onkeydown = event => { if (event.key === 'Enter') $('join').click(); };
document.addEventListener('visibilitychange', () => {
  if (document.hidden) roomPolling.pause();
  else if (mode === 'online') refresh();
});
window.addEventListener('focus', () => { if (mode === 'online') refresh(); });
window.addEventListener('offline', () => {
  roomPolling.pause();
  if (mode === 'online') { live = false; paint(); }
});
window.addEventListener('online', () => { if (mode === 'online') refresh(); });
window.addEventListener('pagehide', () => roomPolling.pause());
window.addEventListener('pageshow', event => { if (event.persisted && mode === 'online') refresh(); });
updateSoundButton();
paint();
const query = new URLSearchParams(location.search).get('room');
if (query) {
  const code = query.trim().toUpperCase();
  if (/^[A-Z0-9]{6}$/.test(code)) { $('code').value = code; invitation(code); }
}
