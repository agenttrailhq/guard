/**
 * TEST-ONLY PRELOAD. Never bundled, never shipped, never imported by src/.
 *
 * Loaded with `node --import ./net-recorder.mjs <bundle>`, it runs BEFORE the bundle
 * and replaces every way out of the process with a recorder that appends to the file
 * named by AGENTTRAIL_TEST_NET_LOG. A network call therefore leaves evidence on disk
 * rather than needing to be intercepted at a socket.
 *
 * AGENTTRAIL_TEST_FAULT=1 additionally makes `JSON.parse` throw on any input, which
 * is how a crash is induced INSIDE THE RELEASED BYTES without the released bytes
 * containing any lever that can be told to fail. That distinction is the whole of
 * Q3: an undocumented switch inside the shipped binary is a way to turn the guard
 * off; a switch inside a test file the user never receives is not.
 *
 * What this proves: the real `dist/cli.js` / `guard-hook.mjs`, crashing for real,
 * make no network call. What it does NOT prove: that a *naturally* occurring crash
 * looks like this one. The fault is a patched global, which is artificial — it is
 * chosen because the hook is engineered to have no input that produces an uncaught
 * throw, which is itself the property the fail-open suite asserts.
 */

import { appendFileSync } from "node:fs";
import http from "node:http";
import https from "node:https";
import net from "node:net";

const LOG = process.env.AGENTTRAIL_TEST_NET_LOG;

function record(what) {
  if (LOG !== undefined) appendFileSync(LOG, `${what}\n`);
  throw new Error(`network call attempted: ${what}`);
}

globalThis.fetch = (input) => record(`fetch ${String(input)}`);
http.request = (...a) => record(`http.request ${String(a[0])}`);
http.get = (...a) => record(`http.get ${String(a[0])}`);
https.request = (...a) => record(`https.request ${String(a[0])}`);
https.get = (...a) => record(`https.get ${String(a[0])}`);
net.connect = (...a) => record(`net.connect ${String(a[0])}`);
net.createConnection = (...a) => record(`net.createConnection ${String(a[0])}`);

if (process.env.AGENTTRAIL_TEST_FAULT === "1") {
  const realParse = JSON.parse.bind(JSON);
  JSON.parse = (...args) => {
    // Throw on the FIRST parse only. The guard's own fail-open path may parse
    // again while handling the fault, and an unconditional throw would test the
    // recursion rather than the crash.
    JSON.parse = realParse;
    throw new SyntaxError("injected fault: parse failed");
  };
}
