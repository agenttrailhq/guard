// cspell:disable -- asserts against credential-SHAPED synthetic fixtures.
/**
 * The secret scrubber's behavioral suite.
 *
 * Every assertion is against the module itself: a real secret shape goes in, and the
 * exact placeholder comes out. The negative cases matter as much as the positive ones:
 * a scrubber that returned `"[REDACTED]"` for every input would satisfy every positive
 * case, and only the negative cases fail it.
 */

import { describe, expect, it } from "vitest";
import { PATTERN_IDS, scrubText } from "../core/scrub.js";
import { BACKSTOP_MS, growth, LINEAR_RATIO } from "./linear-time.js";
import {
  ESCAPE_BOUNDARY_FIXTURES,
  GLUED_TO_A_WORD,
  INTERACTION_FIXTURES,
  NEGATIVE_FIXTURES,
  POSITIVE_FIXTURES,
} from "./scrub-corpus.js";

const SENTINEL = String.fromCharCode(0xe000);

/**
 * The mysql -p timing tests compare a shape with the same text with its triggers renamed
 * (`mysql` to `mxsql`, `-p` to `-q`): the same length, quotes and separators, but the mysql
 * rule's prefilter skips it, so the baseline is the rest of the catalogue on this machine, now.
 * CPU time, best of three each, interleaved, so load moves both alike. An absolute budget failed
 * on loaded machines and CI runners for code that was not slower.
 *
 * Measured at 100 KB (shape / baseline, min to max over 5 interleaved rounds, load average 8-12):
 * the separator runs and the query 0.94-1.05; `mysql -pa ` 1.37-1.56; `mysql"" -p` 1.21-1.28;
 * mysql then `" -pa` x40 1.53-1.64 and `' -pa` x40 1.47-1.62; an apostrophe then `mysql -pa `
 * 1.35-1.41; `"k":"mysql -pX",` 1.29-1.42. `BASELINE_MULTIPLE` leaves about 1.8x room for noise.
 * A quadratic scan fails it many times over: a rescan from the text's start at each candidate
 * measured 98-489x on the dense shapes, and dropping the carried scan state (an earlier,
 * slower design) 3.1-6.3x on five of the six. The 1 MB ceiling and the 15x growth check are
 * kept, and the 1 MB run is timed in the same interleaved loop (`measureShape`).
 */
const BASELINE_MULTIPLE = 3;
const cpuOnce = (text: string) => {
  const started = process.cpuUsage();
  scrubText(text);
  const used = process.cpuUsage(started);
  return (used.user + used.system) / 1000;
};
const untrigger = (text: string) =>
  text
    .replace(/mysql/gi, "mxsql")
    .replace(/mariadb/gi, "mxriadb")
    .replace(/-p/g, "-q");
/** A shape's CPU time and its no-trigger baseline's, best of three each, interleaved. */
const versusBaseline = (text: string) => {
  const plain = untrigger(text);
  let shape = Number.POSITIVE_INFINITY;
  let baseline = Number.POSITIVE_INFINITY;
  for (let run = 0; run < 3; run++) {
    shape = Math.min(shape, cpuOnce(text));
    baseline = Math.min(baseline, cpuOnce(plain));
  }
  return { shape, baseline, ratio: shape / Math.max(baseline, 2) };
};

/**
 * A shape at 100 KB against its no-trigger baseline, and at 1 MB, in one interleaved loop: each
 * of three rounds times the 100 KB shape, its baseline and the 1 MB shape back to back, so a
 * change in load hits all three alike. Best of three each. `growth` is 1 MB over 100 KB: linear
 * is about 10x, quadratic about 100x. One 100 KB pass runs first, and a shape far over the
 * multiple (a quadratic one) is returned before any 1 MB run, so it fails fast.
 */
const measureShape = (make: (n: number) => string) => {
  const smallText = make(100_000);
  const plain = untrigger(smallText);
  let shape = cpuOnce(smallText);
  let baseline = cpuOnce(plain);
  if (shape / Math.max(baseline, 2) > 10 * BASELINE_MULTIPLE) {
    return { ratio: shape / Math.max(baseline, 2), large: Number.NaN, growth: Number.NaN };
  }
  const largeText = make(1_000_000);
  let large = Number.POSITIVE_INFINITY;
  for (let run = 0; run < 3; run++) {
    shape = Math.min(shape, cpuOnce(smallText));
    baseline = Math.min(baseline, cpuOnce(plain));
    large = Math.min(large, cpuOnce(largeText));
  }
  return { ratio: shape / Math.max(baseline, 2), large, growth: large / Math.max(shape, 2) };
};

describe("the corpus itself is complete", () => {
  it("covers every pattern, exactly once", () => {
    // A corpus with a hole would leave a pattern untested, so its completeness is
    // asserted rather than eyeballed.
    expect(POSITIVE_FIXTURES.map((f) => f.id).sort()).toEqual([...PATTERN_IDS].sort());
  });

  it("carries the full standard catalog — 19 patterns, no subset", () => {
    expect(PATTERN_IDS).toHaveLength(19);
    expect(new Set(PATTERN_IDS).size).toBe(19);
  });
});

describe("correctness — each pattern redacts its own secret shape", () => {
  it.each(POSITIVE_FIXTURES)("$id", ({ id, input, secret, placeholder }) => {
    const result = scrubText(input);

    // 1. The secret is gone. This is the only assertion that actually matters to a
    //    reader of a leaked report, so it comes first.
    expect(result.text).not.toContain(secret);
    // 2. The EXACT placeholder is emitted — not merely "something was redacted".
    expect(result.text).toContain(placeholder);
    // 3. Attributed to the right pattern, and counted once. A copy that redacted
    //    via the wrong pattern would pass 1 and 2 and fail here.
    expect(result.redactions).toEqual({ [id]: 1 });
    expect(result.total).toBe(1);
  });

  it("no placeholder ever echoes a meaningful run of the secret it replaced", () => {
    // Every emitted placeholder is checked against EVERY 6-character window of the
    // secret it replaced. No secret-class placeholder carries a hint any more — the AWS
    // key-id last-4 and the connection-string host were both dropped, because each
    // fingerprints something a shared report should not disclose — so every placeholder
    // is a bare `[REDACTED:kind]`. This is the general guard that catches a NEW hint that
    // leaks; the exact placeholders are pinned by the per-fixture assertions above.
    for (const { id, input, secret } of POSITIVE_FIXTURES) {
      const emitted = scrubText(input).text.match(/\[REDACTED:[^\]]*\]/g) ?? [];
      expect(emitted.length, id).toBeGreaterThan(0);
      for (const placeholder of emitted) {
        for (let i = 0; i + 6 <= secret.length; i++) {
          expect(placeholder, `${id} leaked a fragment of its secret`).not.toContain(
            secret.slice(i, i + 6),
          );
        }
      }
    }
  });
});

describe("correctness — benign strings survive untouched", () => {
  // THE assertions that exclude a degenerate copy. Without them, `() => "[REDACTED]"`
  // passes every positive case above and agrees with an equally broken twin.
  it.each(NEGATIVE_FIXTURES)("$name", ({ input }) => {
    expect(scrubText(input)).toEqual({ text: input, redactions: {}, total: 0 });
  });

  it("a Luhn-invalid digit run is neither redacted NOR counted", () => {
    // Stated separately from the fixture loop because the tally is the half a
    // text-only check would miss: suppressing the replacement while still
    // incrementing the counter produces identical text and a wrong report.
    const result = scrubText("order 4111111111111112 shipped");
    expect(result.text).toContain("4111111111111112");
    expect(result.redactions["credit-card"]).toBeUndefined();
    expect(result.total).toBe(0);
  });

  it("rejects digit runs on both sides of the Luhn length window", () => {
    // < 13 digits and > 19 digits both fail before the checksum runs.
    expect(scrubText("id 411111111111").total).toBe(0); // 12
    expect(scrubText("id 41111111111111111111").total).toBe(0); // 20
  });
});

describe("correctness — a secret after an escape sequence or a control code", () => {
  // In JSON-escaped text or coloured terminal output the character before a secret is a
  // letter or a hex digit (`\n`, `ESC[32m`, `\u001b`), so a plain word boundary does not
  // hold there. Each case must still be redacted, once, with its own placeholder.
  it.each(ESCAPE_BOUNDARY_FIXTURES)("$name", ({ input, secret, kind }) => {
    const result = scrubText(input);
    expect(result.text).not.toContain(secret);
    expect(result.text).toContain(`[REDACTED:secret:${kind}`);
    expect(result.total).toBe(1);
  });

  it.each(GLUED_TO_A_WORD)("a secret glued to a word stays as it is: %s", (input) => {
    expect(scrubText(input)).toEqual({ text: input, redactions: {}, total: 0 });
  });

  it.each([
    ["escaped newlines", (n: number) => "\\n".repeat(n)],
    ["unterminated control codes", (n: number) => "\x1b[".repeat(n)],
    ["one control code with a long parameter run", (n: number) => `\x1b[${"1;".repeat(n)}`],
    ["escaped control codes", (n: number) => "\\u001b[".repeat(n)],
    ["unfinished unicode escapes", (n: number) => "\\u00".repeat(n)],
  ] as const)("stays linear on %s", (_name, make) => {
    const { ratio, large } = growth(scrubText, make, 50_000);
    expect(ratio).toBeLessThan(LINEAR_RATIO);
    expect(large).toBeLessThan(BACKSTOP_MS);
  });
});

describe("engine semantics carried over from the source of truth", () => {
  it("an empty string short-circuits", () => {
    expect(scrubText("")).toEqual({ text: "", redactions: {}, total: 0 });
  });

  it("counts repeats rather than deduplicating", () => {
    const result = scrubText("AKIAIOSFODNN7EXAMPLE then AKIAJ7RQEXAMPLE12345");
    expect(result.redactions).toEqual({ "aws-access-key-id": 2 });
    expect(result.total).toBe(2);
  });

  it.each(INTERACTION_FIXTURES)("$name", ({ input, expected }) => {
    const result = scrubText(input);
    expect(result.redactions).toEqual(expected);
    expect(result.total).toBe(Object.values(expected).reduce((a, b) => a + b, 0));
  });

  it("an emitted placeholder is inert to every later pattern", () => {
    // The sentinel guarantee. `[REDACTED:secret:private-key]` contains
    // `PRIVATE KEY`-ish text that the broad `.env` heuristic could otherwise clip,
    // and the placeholder must come out whole.
    const pem =
      "-----BEGIN PRIVATE KEY-----\nMIIEvQIBADANBgkqhkiG9w0BAQ\n-----END PRIVATE KEY-----";
    const result = scrubText(pem);
    expect(result.text).toBe("[REDACTED:secret:private-key]");
    expect(result.total).toBe(1);
  });

  it("does NOT delete a legitimate U+E000 when nothing is redacted", () => {
    // The engine strips the sentinel into a WORKING COPY while scanning. On a
    // zero-redaction value it must return the ORIGINAL string, or it silently eats
    // a legitimate private-use character out of a user's content.
    const input = `private use ${SENTINEL} char, nothing to redact`;
    const result = scrubText(input);
    expect(result.text).toBe(input);
    expect(result.text).toContain(SENTINEL);
    expect(result.total).toBe(0);
  });

  it("strips a pre-existing U+E000 when a redaction DOES occur, without collision", () => {
    // The other branch: once the working copy is returned, a pre-existing sentinel
    // must already be gone, or it would collide with the placeholder scheme and the
    // final restore pass would substitute the wrong slot.
    const result = scrubText(`${SENTINEL} AKIAIOSFODNN7EXAMPLE`);
    expect(result.text).not.toContain(SENTINEL);
    expect(result.text).toBe(" [REDACTED:secret:aws]");
    expect(result.total).toBe(1);
  });

  it("preserves the key name and the ORIGINAL separator in an assignment", () => {
    // Re-emitting the CAPTURED separator rather than a hard-coded `=` is what keeps
    // `key: value` from being rewritten as `key=value`.
    expect(scrubText("API_KEY=abcd1234efgh").text).toBe("API_KEY=[REDACTED:secret:env]");
    expect(scrubText("api_key: abcd1234efgh").text).toBe("api_key: [REDACTED:secret:env]");
  });

  it("a quoted JSON value keeps its quotes, so the output is still valid JSON", () => {
    const out = scrubText('{"api_key": "abcd1234efgh"}').text;
    expect(out).toBe('{"api_key": "[REDACTED:secret:env]"}');
    expect(() => JSON.parse(out)).not.toThrow();
  });

  it("is safe to call repeatedly — the shared global regexes carry no state", () => {
    // Every catalog entry is a `g`-flagged RegExp reused across calls. `replace`
    // resets `lastIndex`; `test`/`exec` do not. If anyone "tidies" a pattern into a
    // `.test()` guard, every other call starts returning a different answer.
    const input = "AKIAIOSFODNN7EXAMPLE and priya@acme.io";
    const first = scrubText(input);
    for (let i = 0; i < 5; i++) expect(scrubText(input)).toEqual(first);
  });

  it("scrubbing twice changes nothing: a placeholder is never rescrubbed", () => {
    const once = scrubText("AKIAIOSFODNN7EXAMPLE and priya@acme.io").text;
    expect(once).toBe("[REDACTED:secret:aws] and [REDACTED:pii:email]");

    const twice = scrubText(once);
    expect(twice.text).toBe(once);
    expect(twice.total).toBe(0);
  });
});

describe("an attached -p password needs mysql or mariadb as the statement's program", () => {
  it.each([
    ["mysqldump -uroot -p'S3cret Pass' db", "mysqldump -uroot -p[REDACTED:secret:password] db"],
    ['mysql -uroot -p"S3cret" db', "mysql -uroot -p[REDACTED:secret:password] db"],
    [
      "sudo -u root /usr/bin/mysql -pletmein",
      "sudo -u root /usr/bin/mysql -p[REDACTED:secret:password]",
    ],
    [
      "timeout 5 nice -n 10 mariadb -psecretpw",
      "timeout 5 nice -n 10 mariadb -p[REDACTED:secret:password]",
    ],
    ["echo q | mysql -psecretpw shop", "echo q | mysql -p[REDACTED:secret:password] shop"],
    [
      '{"command":"mysql -u root -p\\"S3cret\\" shop"}',
      '{"command":"mysql -u root -p[REDACTED:secret:password] shop"}',
    ],
  ])("redacts: %s", (input, expected) => {
    expect(scrubText(input).text).toBe(expected);
  });

  it.each([
    "docker run --name mysql -p3306:3306 mysql:8",
    "find /var/lib/mysql -print",
    "docker compose -f mysql.yml -pmyproj up",
    "systemctl status mysql -pager",
    "kubectl exec mysql-0 -- ls -pla",
    "sudo -u mysql find /var/lib/mysql -print",
    "mysql -u root -p shop",
  ])("leaves alone: %s", (input) => {
    expect(scrubText(input).text).toBe(input);
  });
});

describe("key names: env assignments, quoted keys and headers, not code", () => {
  it.each([
    ["VENDOR_KEY=abc123def456", "VENDOR_KEY=[REDACTED:secret:env]"],
    ['"VENDOR_KEY": "abc123def456"', '"VENDOR_KEY": "[REDACTED:secret:env]"'],
    ["x-api-key: abc123def456", "x-api-key: [REDACTED:secret:env]"],
    [
      "Proxy-Authorization: Basic dXNlcjpwYXNzd29yZA==",
      "Proxy-Authorization: Basic [REDACTED:secret:auth]",
    ],
  ])("redacts: %s", (input, expected) => {
    expect(scrubText(input).text).toBe(expected);
  });

  it.each([
    "primary_key=True",
    "foreign_key: :user_id",
    'hash_key = "LockID"',
    'cache_key = "v1-deps"',
    "idempotency_key: order-1234",
    "data-key={item.id}",
    'public_key = file("~/.ssh/id_rsa.pub")',
    "SSH_KEY=~/.ssh/id_rsa",
    'const STORAGE_KEY = "app-theme";',
    "TEAM_KEY: string;",
    "Idempotency-Key: abc123def456",
  ])("leaves alone: %s", (input) => {
    expect(scrubText(input).text).toBe(input);
  });
});

describe("mysql -p: the program found in code, past exec, ssh, shells and glued statements", () => {
  it.each([
    [
      "docker exec db mysql -uroot -pS3cret",
      "docker exec db mysql -uroot -p[REDACTED:secret:password]",
    ],
    [
      "docker exec -it -u root db mysql -uroot -pS3cret",
      "docker exec -it -u root db mysql -uroot -p[REDACTED:secret:password]",
    ],
    [
      "kubectl exec -it mysql-0 -- mysql -uroot -pS3cret",
      "kubectl exec -it mysql-0 -- mysql -uroot -p[REDACTED:secret:password]",
    ],
    [
      "kubectl -n prod exec mysql-0 -c db -- mysql -pS3cret",
      "kubectl -n prod exec mysql-0 -c db -- mysql -p[REDACTED:secret:password]",
    ],
    ["ssh db1 mysql -pS3cret", "ssh db1 mysql -p[REDACTED:secret:password]"],
    [
      "ssh -p 2222 -i k db1 mysql -pS3cret",
      "ssh -p 2222 -i k db1 mysql -p[REDACTED:secret:password]",
    ],
    ["bash -c 'mysql -pS3cret'", "bash -c 'mysql -p[REDACTED:secret:password]'"],
    [
      'sh -c "mysql -uroot -pS3cret shop"',
      'sh -c "mysql -uroot -p[REDACTED:secret:password] shop"',
    ],
    ["`mysql -pS3cret`", "`mysql -p[REDACTED:secret:password]`"],
    ["x=$(mysql -pS3cret)", "x=$(mysql -p[REDACTED:secret:password])"],
    // Glued statements: both are redacted, and the separator after each stays.
    [
      "mysql -pA1&&mysql -pB2",
      "mysql -p[REDACTED:secret:password]&&mysql -p[REDACTED:secret:password]",
    ],
    [
      "mysql -pA1; mysql -pB2",
      "mysql -p[REDACTED:secret:password]; mysql -p[REDACTED:secret:password]",
    ],
    ["if true; then mysql -pS3cret; fi", "if true; then mysql -p[REDACTED:secret:password]; fi"],
    ["mariadb-dump -pS3cret db", "mariadb-dump -p[REDACTED:secret:password] db"],
    [
      "mariadb-admin -uroot -pS3cret status",
      "mariadb-admin -uroot -p[REDACTED:secret:password] status",
    ],
    ["mariadb-import -pS3cret db t.csv", "mariadb-import -p[REDACTED:secret:password] db t.csv"],
    ["nohup /usr/bin/mysql -pletmein", "nohup /usr/bin/mysql -p[REDACTED:secret:password]"],
    ["mysql -h db -P 3306 -pS3cret", "mysql -h db -P 3306 -p[REDACTED:secret:password]"],
    [
      '{"command":"cd /x && mysql -u root -pS3cret shop"}',
      '{"command":"cd /x && mysql -u root -p[REDACTED:secret:password] shop"}',
    ],
  ])("masked: %s", (input, expected) => {
    expect(scrubText(input).text).toBe(expected);
  });

  it.each([
    "find /var/lib/mysql -perm 600",
    "cp -pr /var/lib/mysql /bak",
    "mkdir -pv /var/run/mysqld",
    "rsync -progress /backup/mysql dst",
    "tar -pczf db.tgz /var/lib/mysql",
    "grep -r bind /etc/mysql -print",
    "echo mysql -pfoo",
    'docker run --name "mysql" -p80 x',
    "xargs -I mysql ls -pla",
    "brew services start mysql -pfoo",
    "mysql-workbench -pfoo",
  ])("left alone: %s", (input) => {
    expect(scrubText(input).text).toBe(input);
  });
});

// CPU-time measurements: one retry, so another process's burst on a shared runner is measured
// again rather than failed. The bounds themselves are unchanged.
describe("mysql -p stays linear on long runs of statement separators around mysql", {
  retry: 1,
  timeout: 300_000,
}, () => {
  // A regex that found the program itself backtracked here: each `;` `&` `|` `(` began a new
  // attempt that rescanned the run (100 KB of `;` then mysql took 4.3 s, 300 KB 38 s). The time
  // is this worker's CPU time, best of three. Linear work grows about 10x from 100 KB
  // to 1 MB and quadratic about 100x; a floor of 2 ms keeps a tiny small run from inflating it.
  const query = (n: number) => {
    let s = "GET /search?db=mysql";
    for (let i = 0; s.length < n; i++) s += `&field${i % 97}=value${i}_${(i * 7919) % 100000}`;
    return s;
  };
  it.each([
    ["';' then mysql", (n: number) => `${";".repeat(n)}mysql -pX`],
    ["'&a=1' then mysql", (n: number) => `${"&a=1".repeat(n / 4)}mysql -pX`],
    ["'env -u a=' then mysql", (n: number) => `${"env -u a=".repeat(Math.ceil(n / 9))}mysql -pX`],
    ["a query with db=mysql", query],
  ])("%s: 100 KB within the no-trigger baseline's multiple, 1 MB in budget and linear", (_label, make) => {
    const run = measureShape(make);
    expect(run.ratio).toBeLessThan(BASELINE_MULTIPLE);
    expect(run.large).toBeLessThan(1500);
    expect(run.growth).toBeLessThan(15);
  });

  it("300 KB of ';' then mysql, within the no-trigger baseline's multiple", () => {
    expect(versusBaseline(`${";".repeat(300_000)}mysql -pX`).ratio).toBeLessThan(BASELINE_MULTIPLE);
  });
});

describe("mysql -p fails toward masking when the shell reading is unsure", () => {
  const PASSWORD = "S3cretPw";
  const KEY = `${["q7Xk2LmP9vR4", "tZ8wN3bY6cH1", "jF5sD0gAeUoI"].join("")}AbCd`;
  it.each([
    // An earlier pattern redacts a secret-bearing assignment; it is still an assignment.
    `DB_PASSWORD=hunter2abc mysql -uroot -p${PASSWORD}`,
    `PASSWORD=hunter2abc mysql -p${PASSWORD}`,
    `API_KEY=${KEY} mysql -p${PASSWORD}`,
    `env DB_PASSWORD=hunter2abc mysql -p${PASSWORD}`,
    `sudo DB_PASSWORD=hunter2abc mysql -p${PASSWORD}`,
    `docker exec db env DB_PASSWORD=hunter2abc mysql -p${PASSWORD}`,
    `{"command":"DB_PASSWORD=hunter2abc mysql -uroot -p${PASSWORD}"}`,
    // A quote that does not close: an apostrophe on an earlier line, in prose, or before `&&`.
    `# don't do this\nmysql -p${PASSWORD}`,
    `{"text":"# don't do this\\nmysql -p${PASSWORD}"}`,
    `{"text":"I can't log in; trying mysql -uroot -p${PASSWORD}"}`,
    `echo it's && mysql -p${PASSWORD}`,
    // Wrappers and command strings.
    `docker compose exec db mysql -uroot -p${PASSWORD}`,
    `docker-compose exec -T db mysql -uroot -p${PASSWORD}`,
    `docker compose -f x.yml exec -u root db mysql -p${PASSWORD}`,
    `ssh host 'mysql -p${PASSWORD}'`,
    `ssh -i k host "mysql -uroot -p${PASSWORD} shop"`,
    `bash -lc 'mysql -p${PASSWORD}'`,
    `bash -xc 'mysql -p${PASSWORD}'`,
    `sudo -iu root mysql -p${PASSWORD}`,
    `["bash","-c","mysql -p${PASSWORD}"]`,
    `gosu mysql mysql -p${PASSWORD}`,
    `su-exec mysql mysql -p${PASSWORD}`,
    // A line continuation, raw and JSON-escaped.
    `mysql -uroot \\\n -p${PASSWORD}`,
    `{"command":"mysql -uroot \\\\\\n -p${PASSWORD}"}`,
  ])("masked: %j", (input) => {
    const out = scrubText(input).text;
    expect(out).not.toContain(PASSWORD);
    expect(out).toContain("-p[REDACTED:secret:password]");
  });

  it.each([
    // `-P` is the port flag.
    "mysql -h db -P3306 -uroot -p",
    "mysql -h db -P3306 shop",
    // An apostrophe on an earlier line does not make another program's -p a password.
    "I don't know\ndocker run --name mysql -p3306:3306 mysql:8",
  ])("left alone: %j", (input) => {
    expect(scrubText(input).text).toBe(input);
  });

  it("keeps the port and masks the password", () => {
    expect(scrubText(`mysql -h db -P3306 -uroot -p${PASSWORD}`).text).toBe(
      "mysql -h db -P3306 -uroot -p[REDACTED:secret:password]",
    );
  });
});

// CPU-time measurements: one retry, as above. The bounds are unchanged.
describe("mysql -p stays linear on text dense with candidates and quotes", {
  retry: 1,
  timeout: 300_000,
}, () => {
  // Each candidate used to read 512 characters back, with a slice and a regex at every quote:
  // `mysql"" -p` repeated took 105 ms at 100 KB. The scan state now carries to the next
  // candidate. CPU time, best of three.
  const rep = (unit: string, n: number) => unit.repeat(Math.ceil(n / unit.length)).slice(0, n);
  it.each([
    ["'mysql -pa ' repeated", (n: number) => rep("mysql -pa ", n)],
    ["'mysql\"\" -p' repeated", (n: number) => rep('mysql"" -p', n)],
    ["mysql then '\" -pa' x40, repeated", (n: number) => rep(`mysql${'" -pa'.repeat(40)}`, n)],
    ['mysql then "\' -pa" x40, repeated', (n: number) => rep(`mysql${"' -pa".repeat(40)}`, n)],
    ["an apostrophe, then 'mysql -pa ' repeated", (n: number) => `'${rep("mysql -pa ", n)}`],
    ['\'"k":"mysql -pX",\' repeated', (n: number) => rep('"k":"mysql -pX",', n)],
  ])("%s: 100 KB within the no-trigger baseline's multiple, 1 MB in budget and linear", (_label, make) => {
    const run = measureShape(make);
    expect(run.ratio).toBeLessThan(BASELINE_MULTIPLE);
    expect(run.large).toBeLessThan(1500);
    expect(run.growth).toBeLessThan(15);
  });
});

describe("mysql -p past docker run, kubectl run, shell quoting and argv arrays", () => {
  const PASSWORD = "S3cretPw";
  const R = "[REDACTED:secret:password]";
  it.each([
    // The program after `docker run`'s options and image, and after `kubectl run … --`.
    [
      `docker run --rm -it mysql:8 mysql -h db -uroot -p${PASSWORD}`,
      `docker run --rm -it mysql:8 mysql -h db -uroot -p${R}`,
    ],
    [
      `docker run --rm -e MYSQL_HOST=db mysql:8 mysqldump -uroot -p${PASSWORD} shop`,
      `docker run --rm -e MYSQL_HOST=db mysql:8 mysqldump -uroot -p${R} shop`,
    ],
    [
      `docker run -it --network host --rm mysql mysql -h127.0.0.1 -uroot -p${PASSWORD}`,
      `docker run -it --network host --rm mysql mysql -h127.0.0.1 -uroot -p${R}`,
    ],
    [`podman run mysql mysql -p${PASSWORD}`, `podman run mysql mysql -p${R}`],
    [
      `docker container run --rm mysql:8 mysql -p${PASSWORD}`,
      `docker container run --rm mysql:8 mysql -p${R}`,
    ],
    [
      `docker run --rm -it --entrypoint mysql mysql:8 -h db -p${PASSWORD}`,
      `docker run --rm -it --entrypoint mysql mysql:8 -h db -p${R}`,
    ],
    [
      `docker run --entrypoint=/usr/bin/mysqldump mysql:8 -p${PASSWORD} shop`,
      `docker run --entrypoint=/usr/bin/mysqldump mysql:8 -p${R} shop`,
    ],
    [
      `kubectl run -it --rm mysql-client --image=mysql:8 --restart=Never -- mysql -h db -uroot -p${PASSWORD}`,
      `kubectl run -it --rm mysql-client --image=mysql:8 --restart=Never -- mysql -h db -uroot -p${R}`,
    ],
    [
      `kubectl debug -it db-0 --image=mysql:8 -- mysql -p${PASSWORD}`,
      `kubectl debug -it db-0 --image=mysql:8 -- mysql -p${R}`,
    ],
    // Shell quoting: ANSI-C, and a quoted part with an unquoted tail glued on.
    [`mysql -uroot -p$'${PASSWORD}' db`, `mysql -uroot -p${R} db`],
    [`mysql -uroot -p$'S3c\\'ret' db`, `mysql -uroot -p${R} db`],
    [`mysql -p"${PASSWORD}"tail db`, `mysql -p${R} db`],
    [`mysql -p'S3c'ret db`, `mysql -p${R} db`],
    [`mysql -p'${"x".repeat(300)}' db`, `mysql -p${R} db`],
    // A quoted or escaped program word, or one from a command substitution.
    [`"/usr/local/bin/mysql" -p${PASSWORD}`, `"/usr/local/bin/mysql" -p${R}`],
    [`'mysql' -p${PASSWORD}`, `'mysql' -p${R}`],
    [`\\mysql -p${PASSWORD}`, `\\mysql -p${R}`],
    [`$(which mysql) -p${PASSWORD}`, `$(which mysql) -p${R}`],
    [`\`which mysql\` -h db -p${PASSWORD}`, `\`which mysql\` -h db -p${R}`],
    // eval, npx dotenv, a JSON-escaped `&&`.
    [`eval mysql -p${PASSWORD}`, `eval mysql -p${R}`],
    [`npx dotenv -- mysql -p${PASSWORD}`, `npx dotenv -- mysql -p${R}`],
    [`npx dotenv -e .env.test -- mysql -p${PASSWORD}`, `npx dotenv -e .env.test -- mysql -p${R}`],
    [
      `{"command":"cd /app \\u0026\\u0026 mysql -p${PASSWORD}"}`,
      `{"command":"cd /app \\u0026\\u0026 mysql -p${R}"}`,
    ],
    // Exec-form argv: a JSON array, a Dockerfile CMD, and the shell form of CMD and RUN.
    [`["mysql", "-uroot", "-p${PASSWORD}"]`, `["mysql", "-uroot", "-p${R}"]`],
    [`CMD ["mysql", "-h", "db", "-p${PASSWORD}"]`, `CMD ["mysql", "-h", "db", "-p${R}"]`],
    [`["/usr/bin/mysqldump","-p${PASSWORD}","shop"]`, `["/usr/bin/mysqldump","-p${R}","shop"]`],
    [`{"argv":[\\"mysql\\", \\"-p${PASSWORD}\\"]}`, `{"argv":[\\"mysql\\", \\"-p${R}\\"]}`],
    [`CMD mysql -p${PASSWORD}`, `CMD mysql -p${R}`],
    [`RUN mysql -p${PASSWORD} -e 'select 1'`, `RUN mysql -p${R} -e 'select 1'`],
  ])("masked: %j", (input, expected) => {
    expect(scrubText(input).text).toBe(expected);
  });

  it.each([
    // A statement that starts more than 512 characters back is unsure, so it masks.
    `docker exec -e PATH=${"/x".repeat(250)} db mysql -uroot -p${PASSWORD}`,
    `sudo -u root ${"A=1 ".repeat(120)}mysql -p${PASSWORD}`,
  ])("masked when the statement starts out of the window: %j", (input) => {
    const out = scrubText(input).text;
    expect(out).not.toContain(PASSWORD);
    expect(out).toContain(`-p${R}`);
  });

  it.each([
    // docker run's own -p, and an image named mysql, are not a password.
    "docker run --name mysql -p3306:3306 mysql:8",
    "docker run -d -v /var/lib/mysql:/var/lib/mysql -p3306:3306 mysql:8",
    "docker run --rm --name db mysql -p3306:3306",
    "podman run -e MYSQL_ROOT_HOST=% --name mysql -p 3306:3306 mysql",
    "kubectl run mysql --image=mysql:8 --port=3306 -- ls -pla",
    "docker run --entrypoint sh --name mysql -p3306:3306 mysql:8",
    // A quoted argument, a substitution that is not the program, and argv for another program.
    "echo 'mysql' -pfoo",
    "ls $(which mysql) -pla",
    '["docker", "run", "--name", "mysql", "-p3306:3306", "mysql:8"]',
    '["find", "/var/lib/mysql", "-print"]',
    // A closing quote after the value is not glued on: the JSON string and bash -c end there.
    '{"command":"mysql -pS3cretPw","cwd":"/app"}',
    "bash -c 'mysql -pS3cretPw' && echo 'done'",
  ])("what stands around it is left alone: %j", (input) => {
    const out = scrubText(input).text;
    if (input.includes("S3cretPw")) {
      expect(out).not.toContain("S3cretPw");
      expect(out.replace(`-p${R}`, "-pS3cretPw")).toBe(input);
    } else {
      expect(out).toBe(input);
    }
  });
});

describe("mysql -p after a YAML key, a list item or a prompt; a bare -p keeps its outer quote", () => {
  const PASSWORD = "S3cretPw";
  const R = "[REDACTED:secret:password]";
  it.each([
    // A YAML key, a list item or a shell prompt leads the line; the program follows it.
    [
      `run: mysql -h 127.0.0.1 -uroot -p${PASSWORD} -e 'CREATE DATABASE t'`,
      `run: mysql -h 127.0.0.1 -uroot -p${R} -e 'CREATE DATABASE t'`,
    ],
    [`steps:\n  - run: mysql -uroot -p${PASSWORD}`, `steps:\n  - run: mysql -uroot -p${R}`],
    [
      `script:\n  - mysql -h db -uroot -p${PASSWORD} < dump.sql`,
      `script:\n  - mysql -h db -uroot -p${R} < dump.sql`,
    ],
    [`  - mysql -uroot -p${PASSWORD}`, `  - mysql -uroot -p${R}`],
    [`command: mysqldump -uroot -p${PASSWORD} shop`, `command: mysqldump -uroot -p${R} shop`],
    [`entrypoint: mysql -p${PASSWORD}`, `entrypoint: mysql -p${R}`],
    [
      `healthcheck:\n  test: mysqladmin ping -uroot -p${PASSWORD}`,
      `healthcheck:\n  test: mysqladmin ping -uroot -p${R}`,
    ],
    [`$ mysql -uroot -p${PASSWORD}`, `$ mysql -uroot -p${R}`],
    [`root@db:~# mysql -uroot -p${PASSWORD}`, `root@db:~# mysql -uroot -p${R}`],
    [`user@host:~/app$ mysql -uroot -p${PASSWORD}`, `user@host:~/app$ mysql -uroot -p${R}`],
    [`% mysql -uroot -p${PASSWORD}`, `% mysql -uroot -p${R}`],
    [`> mysql -uroot -p${PASSWORD}`, `> mysql -uroot -p${R}`],
    [`1. mysql -uroot -p${PASSWORD}`, `1. mysql -uroot -p${R}`],
    [`2) mysql -uroot -p${PASSWORD}`, `2) mysql -uroot -p${R}`],
    [`* mysql -uroot -p${PASSWORD}`, `* mysql -uroot -p${R}`],
    // docker's global options before exec / run, value options the table lacked, an empty
    // entrypoint, and --volumes-from.
    [
      `docker --context prod exec db mysql -p${PASSWORD}`,
      `docker --context prod exec db mysql -p${R}`,
    ],
    [
      `docker -H tcp://h:2375 run --rm mysql:8 mysql -p${PASSWORD}`,
      `docker -H tcp://h:2375 run --rm mysql:8 mysql -p${R}`,
    ],
    [
      `docker --log-level debug run --rm mysql:8 mysql -p${PASSWORD}`,
      `docker --log-level debug run --rm mysql:8 mysql -p${R}`,
    ],
    [
      `docker run --pids-limit 100 --oom-score-adj 10 mysql:8 mysql -p${PASSWORD}`,
      `docker run --pids-limit 100 --oom-score-adj 10 mysql:8 mysql -p${R}`,
    ],
    [
      `docker run --health-start-period 5s --memory-swappiness 0 mysql:8 mysql -p${PASSWORD}`,
      `docker run --health-start-period 5s --memory-swappiness 0 mysql:8 mysql -p${R}`,
    ],
    [
      `podman run --uidmap 0:1:1 --gidmap 0:1:1 mysql:8 mysql -p${PASSWORD}`,
      `podman run --uidmap 0:1:1 --gidmap 0:1:1 mysql:8 mysql -p${R}`,
    ],
    [
      `docker run --entrypoint "" mysql:8 mysql -p${PASSWORD}`,
      `docker run --entrypoint "" mysql:8 mysql -p${R}`,
    ],
    [
      `docker run --volumes-from data mysql:8 mysql -p${PASSWORD}`,
      `docker run --volumes-from data mysql:8 mysql -p${R}`,
    ],
  ])("masked: %j", (input, expected) => {
    expect(scrubText(input).text).toBe(expected);
  });

  it.each([
    // Other programs after a YAML key or a list item keep their -p.
    "command: docker run --name mysql -p3306:3306 mysql:8",
    "- docker run --name mysql -p3306:3306 mysql:8",
    "ports: docker compose -f mysql.yml -pmyproj up",
    "description: connect with mysql -p",
    "$ find /var/lib/mysql -print",
    "1. ls /var/lib/mysql -pla",
    "docker --context prod run --name mysql -p3306:3306 mysql:8",
    // A bare -p prompts: it has no value, and the quote after it closes the outer string.
    '{"command":"mysql -uroot -p","description":"connect"}',
    '{"cmd":"mysql -h db -p", "n": 1}',
    "bash -c 'mysql -uroot -p' && echo 'done'",
    'echo "run mysql -uroot -p" && echo "ok"',
    `{"command":"bash -c 'mysql -uroot -p' && echo 'done'"}`,
  ])("left alone: %j", (input) => {
    expect(scrubText(input).text).toBe(input);
  });
});

describe("mysql -p on both sides of each quote boundary", () => {
  const R = "[REDACTED:secret:password]";
  const parses = (text: string) => {
    if (text.startsWith("{")) expect(() => JSON.parse(text)).not.toThrow();
  };
  it.each([
    // A quoted password may open with whitespace or `, : } ]` when the reading is sure.
    ['mysql -uroot -p",S3cret"', `mysql -uroot -p${R}`],
    ["mysql -uroot -p':S3cret'", `mysql -uroot -p${R}`],
    ['mysql -uroot -p"}S3cret"', `mysql -uroot -p${R}`],
    ['mysql -uroot -p" S3cret"', `mysql -uroot -p${R}`],
    ["mysql -uroot -p' leading space'", `mysql -uroot -p${R}`],
    [`{"command":"mysql -uroot -p' S3cret' db"}`, `{"command":"mysql -uroot -p${R} db"}`],
    // A quote left open on an earlier line does not hold this line's statement.
    ['"I tried this\nmysql -uroot -p"S3cretPw" shop', `"I tried this\nmysql -uroot -p${R} shop`],
    ["'step one\nmysql -uroot -p'S3cretPw' db", `'step one\nmysql -uroot -p${R} db`],
    [
      '{"text":"\\"why does\\nmysql -uroot -p\\"S3cretPw\\" fail"}',
      `{"text":"\\"why does\\nmysql -uroot -p${R} fail"}`,
    ],
    [
      `{"text":"'Run this:\\nmysql -uroot -p'S3cretPw' db"}`,
      `{"text":"'Run this:\\nmysql -uroot -p${R} db"}`,
    ],
    // An unquoted value stops at a JSON-escaped closing quote.
    [
      '{"command":"sh -c \\"mysql -uroot -pS3cretPw\\""}',
      `{"command":"sh -c \\"mysql -uroot -p${R}\\""}`,
    ],
    // A JSON-escaped backslash (`\\\\`) is one unit: the value takes it whole, so the quote after
    // it still closes the JSON string. Its other side, a lone `\\` before `"`, is the bare
    // `sh -c \\"mysql -uroot -p\\""` cases below.
    ['{"command":"mysql -uroot -pS3cretPw\\\\"}', `{"command":"mysql -uroot -p${R}"}`],
  ])("masked: %j", (input, expected) => {
    const out = scrubText(input).text;
    expect(out).toBe(expected);
    parses(out);
  });

  it.each([
    // The same boundaries with a bare -p: the quote after it is not a password.
    'echo "run mysql -uroot -p" && echo "ok"',
    '{"cmd":"mysql -h db -p", "n": 1}',
    '"I tried this\nmysql -uroot -p"',
    '{"text":"\\"why does\\nmysql -uroot -p\\" fail"}',
    '{"command":"sh -c \\"mysql -uroot -p\\""}',
    '{"command":"bash -lc \\"mysql -h db -uroot -p\\"","cwd":"/app"}',
    '{"command":"mysql -uroot -p\\"\\" db"}',
  ])("left alone: %j", (input) => {
    expect(scrubText(input).text).toBe(input);
  });
});
