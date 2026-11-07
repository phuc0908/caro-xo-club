import { before, after, test } from 'node:test';
import assert from 'node:assert/strict';
import { startTestApp } from './helpers/test-server.mjs';

let app;
before(async () => { app = await startTestApp(); });
after(async () => { await app?.stop(); });
const post = async body => {
  const response = await fetch(app.url + '/api/game', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  return { response, data: await response.json() };
};
const get = (room, revision) => fetch(app.url + '/api/game?' + new URLSearchParams({ room, ...(revision === undefined ? {} : { revision }) }));

test('initial GET stays compatible and conditional checks return no board when unchanged', async () => {
  const { data: created } = await post({ action: 'create', name: 'X' });
  const code = created.game.code;
  const initial = await get(code);
  assert.equal(initial.status, 200);
  assert.equal((await initial.json()).game.revision, 1);
  const before = app.commands.length;
  const unchanged = await get(code, 1);
  assert.equal(unchanged.status, 204);
  assert.equal(await unchanged.text(), '');
  assert.equal(unchanged.headers.get('cache-control'), 'no-store');
  assert.equal(app.commands.length - before, 1, 'One Redis request per conditional check');
  assert.equal(app.commands.at(-1)[0], 'EVAL', 'Revision is checked inside Redis');
  const key = 'caro:v1:' + code;
  assert.equal(JSON.parse(app.rooms.get(key)).revision, 1, 'Reading does not change the room');
});

test('joins and moves become visible with the new revision, without exposing private IDs', async () => {
  const { data: x } = await post({ action: 'create', name: 'X' });
  const code = x.game.code;
  const { data: o } = await post({ action: 'join', room: code, name: 'O' });
  const joined = await get(code, 1);
  const snapshot = await joined.json();
  assert.equal(snapshot.game.revision, 2);
  assert.equal(snapshot.game.players.O.name, 'O');
  assert.equal('ids' in snapshot.game, false);
  assert(!JSON.stringify(snapshot).includes(x.id));
  assert(!JSON.stringify(snapshot).includes(o.id));
  const { response: move, data: next } = await post({ action: 'move', room: code, id: x.id, row: 7, col: 7 });
  assert.equal(move.status, 200);
  assert.equal(next.game.revision, 3);
  const changed = await get(code, 2);
  assert.equal((await changed.json()).game.board[112], 'X');
  assert.equal((await get(code, 3)).status, 204);
  assert.equal((await get(code, 999)).status, 200, 'A stale/newer client still receives a full current snapshot');
});

test('an expired room is 404, not indistinguishable from an unchanged room', async () => {
  const { data } = await post({ action: 'create' });
  app.rooms.delete('caro:v1:' + data.game.code);
  const response = await get(data.game.code, 1);
  assert.equal(response.status, 404);
  assert.match((await response.json()).error, /hết hạn/);
});

test('malformed revisions are rejected before reading Redis', async () => {
  const before = app.commands.length;
  for (const revision of ['-1', '1.5', 'NaN', '', '9007199254740992', '1e2']) {
    assert.equal((await get('ABC123', revision)).status, 400, revision);
  }
  assert.equal(app.commands.length, before);
});

test('rate limits and temporary upstream failures include a useful Retry-After', async () => {
  try {
    app.setFailure({ status: 429, retryAfter: '12' });
    const limited = await get('ABC123', 1);
    assert.equal(limited.status, 429);
    assert.equal(limited.headers.get('retry-after'), '12');
    app.setFailure({ status: 503, retryAfter: '7' });
    const unavailable = await get('ABC123', 1);
    assert.equal(unavailable.status, 503);
    assert.equal(unavailable.headers.get('retry-after'), '7');
  } finally { app.setFailure(null); }
});

test('win detection and two-player rematches keep working with revision checks', async () => {
  const { data: x } = await post({ action: 'create' });
  const room = x.game.code;
  const { data: o } = await post({ action: 'join', room });
  let latest;
  for (let c = 0; c < 4; c++) {
    await post({ action: 'move', room, id: x.id, row: 7, col: c });
    await post({ action: 'move', room, id: o.id, row: 0, col: c });
  }
  ({ data: latest } = await post({ action: 'move', room, id: x.id, row: 7, col: 4 }));
  assert.equal(latest.game.winner, 'X');
  const finishedRevision = latest.game.revision;
  assert.equal((await get(room, finishedRevision)).status, 204);
  const { data: invited } = await post({ action: 'rematch', room, id: x.id });
  assert.equal((await (await get(room, finishedRevision)).json()).game.rematch[0], 'X');
  const { data: replay } = await post({ action: 'rematch', room, id: o.id });
  assert.equal(replay.game.status, 'playing');
  assert.equal(replay.game.round, 2);
  assert(replay.game.revision > invited.game.revision);
  assert.equal((await get(room, replay.game.revision)).status, 204);
});

test('the browser polling module is served as JavaScript', async () => {
  const response = await fetch(app.url + '/polling.js');
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type'), /javascript/);
  const index = await (await fetch(app.url)).text();
  assert.match(index, /src="\/app.js" type="module"/);
});
