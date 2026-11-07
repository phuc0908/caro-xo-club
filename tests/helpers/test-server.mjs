import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../', import.meta.url));
const listen = async server => { server.listen(0, '127.0.0.1'); await once(server, 'listening'); return server.address().port; };

// Only the Redis commands used by this application are implemented. The actual
// API and local server run in a separate process, with no production credentials.
export async function startTestApp() {
  const rooms = new Map(), commands = [];
  let failure = null;
  const redis = createServer(async (req, res) => {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    const [command, ...args] = JSON.parse(raw);
    commands.push([command, ...args]);
    res.setHeader('Content-Type', 'application/json');
    if (failure) {
      res.statusCode = failure.status;
      res.setHeader('Retry-After', failure.retryAfter || '5');
      res.end(JSON.stringify({ error: 'Temporary test failure' }));
      return;
    }
    let result;
    if (command === 'GET') result = rooms.get(args[0]) ?? null;
    else if (command === 'SET') {
      if (args.includes('NX') && rooms.has(args[0])) result = null;
      else { rooms.set(args[0], args[1]); result = 'OK'; }
    } else if (command === 'EVAL' && args.length === 4) {
      const [, , key, revision] = args;
      const current = rooms.get(key);
      result = !current ? 0 : JSON.parse(current).revision === Number(revision) ? null : current;
    } else if (command === 'EVAL' && args.length === 6) {
      const [, , key, revision, next] = args;
      const current = rooms.get(key);
      if (!current) result = 'MISSING';
      else if (JSON.parse(current).revision !== Number(revision)) result = 'CONFLICT';
      else { rooms.set(key, next); result = 'OK'; }
    } else {
      res.statusCode = 500;
      res.end(JSON.stringify({ error: 'Unsupported test command' }));
      return;
    }
    res.end(JSON.stringify({ result }));
  });
  const redisPort = await listen(redis);
  const reservation = createServer();
  const port = await listen(reservation);
  await new Promise(resolve => reservation.close(resolve));
  const child = spawn(process.execPath, ['dev-server.mjs'], {
    cwd: root,
    env: { ...process.env, PORT: String(port), UPSTASH_REDIS_REST_URL: `http://127.0.0.1:${redisPort}`, UPSTASH_REDIS_REST_TOKEN: 'isolated-test-token' },
    stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
  });
  let output = '';
  child.stdout.on('data', chunk => { output += chunk; });
  child.stderr.on('data', chunk => { output += chunk; });
  try {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(Error('Test server startup timed out: ' + output)), 8000);
      child.stdout.on('data', chunk => { if (String(chunk).includes(`localhost:${port}`)) { clearTimeout(timer); resolve(); } });
      child.once('error', error => { clearTimeout(timer); reject(error); });
      child.once('exit', code => { clearTimeout(timer); reject(Error(`Test server exited (${code}): ${output}`)); });
    });
  } catch (error) { child.kill(); redis.close(); throw error; }
  return {
    url: `http://127.0.0.1:${port}`, rooms, commands,
    setFailure: value => { failure = value; },
    async stop() {
      if (child.exitCode === null && child.signalCode === null) {
        const exited = once(child, 'exit');
        child.kill();
        await exited;
      }
      await new Promise(resolve => redis.close(resolve));
    },
  };
}
