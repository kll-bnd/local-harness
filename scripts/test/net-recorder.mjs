// Test preload (`node --import ./scripts/test/net-recorder.mjs tool.mjs`): records every outgoing socket a tool
// opens (net.Socket#connect — fetch, http.request and net.connect all go through it) and every browser it would
// open (`open` / `xdg-open` / `cmd /c start`, which are NOT run), one JSON line each, to $HARNESS_TEST_NET_RECORD.
// Used to assert that nothing a lock file names is ever connected to or opened. Never loaded outside the tests.
import net from 'node:net';
import fs from 'node:fs';
import cp from 'node:child_process';
import { EventEmitter } from 'node:events';
import { syncBuiltinESMExports } from 'node:module';

const out = process.env.HARNESS_TEST_NET_RECORD;
const write = (o) => { if (out) fs.appendFileSync(out, `${JSON.stringify(o)}\n`); };

const connect = net.Socket.prototype.connect;
net.Socket.prototype.connect = function recordConnect(...args) {
  let o = Array.isArray(args[0]) ? args[0][0] : args[0];
  if (typeof o !== 'object' || o === null) o = { port: o, host: typeof args[1] === 'string' ? args[1] : undefined };
  write({ kind: 'connect', host: o.path ? null : (o.host ?? 'localhost'), port: o.port ?? null, path: o.path ?? null });
  return connect.apply(this, args);
};

const spawn = cp.spawn;
cp.spawn = function recordSpawn(cmd, argv = [], opts) {
  if (cmd === 'open' || cmd === 'xdg-open' || cmd === 'cmd') {
    write({ kind: 'open', cmd, args: argv });
    const child = new EventEmitter();
    child.unref = () => {};
    return child;
  }
  return spawn.call(this, cmd, argv, opts);
};
syncBuiltinESMExports();
