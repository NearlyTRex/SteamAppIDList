// steamcmd_appid.js, against a fake Steam client: nothing here talks to Steam.

const assert = require("node:assert");
const { spawnSync } = require("node:child_process");
const { EventEmitter } = require("node:events");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { mock, test } = require("node:test");
const SteamUser = require("steam-user");

const SCRIPT = path.join(__dirname, "..", "..", "steamcmd_appid.js");
const appid = require(SCRIPT);

const PICS_REQUEST = SteamUser.EMsg.ClientPICSProductInfoRequest;
// Small enough that a scan takes a few batches and a failure no time at all
const FAST = { batch: 10, attempts: 2, timeoutMs: 1000, retryDelayMs: 0, margin: 20, emptyBatchesToStop: 2 };

// Answers getProductChanges with changes and getProductInfo with the apps it holds, by appid
class FakeClient extends EventEmitter {
  constructor(apps = {}, changes = []) {
    super();
    this.apps = apps;
    this.changes = changes;
    this.requested = [];
    this.loggedOff = false;
  }

  logOn() {
    setImmediate(() => this.emit("loggedOn"));
  }

  logOff() {
    this.loggedOff = true;
  }

  async getProductChanges(since) {
    return { currentChangeNumber: 5000, appChanges: since ? this.changes.map((id) => ({ appid: id })) : [] };
  }

  async getProductInfo(ids) {
    this.requested.push(ids[0]);
    const found = ids.filter((id) => id in this.apps).map((id) => [id, { appinfo: this.apps[id] }]);
    return { apps: Object.fromEntries(found) };
  }
}

function named(name) {
  return { common: { name } };
}

function tempOutput(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "steamcmd-appid-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return path.join(dir, "steamcmd_appid");
}

function writeList(output, apps) {
  fs.writeFileSync(`${output}.json`, JSON.stringify({ applist: { apps } }));
}

function quiet(t) {
  for (const method of ["log", "warn", "error"]) t.mock.method(console, method, () => {});
}

// A SteamUser whose sends are kept rather than sent, with patchEmptyApps over it
function patchedClient() {
  const client = new SteamUser();
  const sent = [];
  client._send = (emsgOrHeader, body, callback) => sent.push({ emsgOrHeader, body, callback });
  appid.patchEmptyApps(client);
  return { client, sent };
}

test("an app Steam sends without info no longer crashes steam-user", async () => {
  const { client, sent } = patchedClient();
  client.steamID = {};
  const info = client.getProductInfo([10, 20], [], false);
  sent[0].callback({ apps: [
    { appid: 10, change_number: 1, buffer: Buffer.from('"appinfo"\n{\n"common"\n{\n"name" "Counter-Strike"\n}\n}\n\0') },
    { appid: 20, change_number: 1, buffer: null },
  ] });
  const { apps } = await info;
  assert.strictEqual(apps[10].appinfo.common.name, "Counter-Strike");
  assert.deepStrictEqual(apps[20].appinfo, {});
});

test("other messages, and product info requests nobody waits on, pass through untouched", () => {
  const { client, sent } = patchedClient();
  const callback = () => {};
  client._send(PICS_REQUEST + 1, "body", callback);
  client._send({ msg: PICS_REQUEST }, "body");
  assert.strictEqual(sent[0].callback, callback);
  assert.deepStrictEqual(sent[1].emsgOrHeader, { msg: PICS_REQUEST });
  assert.strictEqual(sent[1].callback, undefined);
});

test("a product info response without apps reaches the callback as it came", () => {
  const { client, sent } = patchedClient();
  const seen = [];
  client._send({ msg: PICS_REQUEST }, {}, (response, extra) => seen.push([response, extra]));
  sent[0].callback({}, "header");
  sent[0].callback(undefined);
  assert.deepStrictEqual(seen, [[{}, "header"], [undefined, undefined]]);
});

test("the previous list is read by appid, and is empty when there is none", (t) => {
  const output = tempOutput(t);
  assert.strictEqual(appid.readPrevious(output).size, 0);
  writeList(output, [{ appid: 10, name: "Counter-Strike" }]);
  assert.deepStrictEqual([...appid.readPrevious(output)], [[10, "Counter-Strike"]]);
});

test("a request that answers in time is returned, and one that doesn't is an error", async () => {
  assert.strictEqual(await appid.withTimeout(Promise.resolve("ok"), "fast", 1000), "ok");
  await assert.rejects(appid.withTimeout(new Promise(() => {}), "Slow", 1), { message: "Slow timed out" });
});

test("a request that fails is retried, then given up on after the last attempt", async (t) => {
  quiet(t);
  const flaky = mock.fn(async () => {
    if (flaky.mock.callCount() === 0) throw new Error("busy");
    return "ok";
  });
  assert.strictEqual(await appid.retry("flaky", flaky, FAST), "ok");
  assert.strictEqual(flaky.mock.callCount(), 2);
  assert.match(console.warn.mock.calls[0].arguments[0], /flaky failed \(busy\), retrying/);

  const broken = async () => { throw new Error("down"); };
  await assert.rejects(appid.retry("broken", broken, FAST), { message: "broken failed 2 times: down" });
});

test("the scan names apps, carries unnamed ones from the last list and stops past the newest", async (t) => {
  quiet(t);
  // 5 is named; 7 has no name but was in the last list; 8 has neither and is left out. 45, a
  // recent change, sets how far the scan must reach, then two empty batches end it.
  const client = new FakeClient({ 5: named("Five"), 7: {}, 8: {}, 45: named("Forty-five") }, [45]);
  const names = await appid.scan(client, new Map([[7, "Seven"], [12, "Gone"]]), FAST);
  assert.deepStrictEqual([...names], [[5, "Five"], [7, "Seven"], [45, "Forty-five"]]);
  assert.deepStrictEqual(client.requested, [0, 10, 20, 30, 40, 50, 60]);
  assert.match(console.log.mock.calls.at(-1).arguments[0], /Found 3 apps, 1 of them named from the previous list/);
});

test("names are made safe for XML", () => {
  assert.strictEqual(appid.xmlEscape("A\u0001B & <C>￿"), "AB &amp; &lt;C&gt;");
});

test("the lists are written sorted by appid in json, csv and xml", (t) => {
  quiet(t);
  const output = tempOutput(t);
  appid.write(new Map([[20, 'Say "hi"'], [10, "R&D"]]), output);
  const json = JSON.parse(fs.readFileSync(`${output}.json`, "utf8"));
  assert.deepStrictEqual(json.applist.apps, [{ appid: 10, name: "R&D" }, { appid: 20, name: 'Say "hi"' }]);
  assert.strictEqual(fs.readFileSync(`${output}.csv`, "utf8"), '10,"R&D"\n20,"Say ""hi"""\n');
  const xml = fs.readFileSync(`${output}.xml`, "utf8");
  assert.ok(xml.startsWith('<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE applist>\n<applist>\n\t<apps>\n'));
  assert.ok(xml.includes("\t\t<app>\n\t\t\t<appid>10</appid>\n\t\t\t<name>R&amp;D</name>\n\t\t</app>\n"));
});

test("a run writes the new list, reports Steam's errors and logs off", async (t) => {
  quiet(t);
  const output = tempOutput(t);
  writeList(output, [{ appid: 7, name: "Seven" }]);
  const client = new FakeClient({ 5: named("Five"), 7: {} });
  client.once("loggedOn", () => client.emit("error", new Error("hiccup")));
  await appid.main({ ...FAST, output }, client);
  assert.ok(client.loggedOff);
  assert.strictEqual(console.warn.mock.calls[0].arguments[0], "Steam: hiccup");
  const apps = JSON.parse(fs.readFileSync(`${output}.json`, "utf8")).applist.apps;
  assert.deepStrictEqual(apps, [{ appid: 5, name: "Five" }, { appid: 7, name: "Seven" }]);
});

test("a list much shorter than the last one is refused and the old one kept", async (t) => {
  quiet(t);
  const output = tempOutput(t);
  const last = Array.from({ length: 10 }, (_, i) => ({ appid: i, name: `App ${i}` }));
  writeList(output, last);
  const client = new FakeClient({ 1: named("One") });
  await assert.rejects(appid.main({ ...FAST, output }, client),
    { message: "Only 1 apps found, against 10 last time; keeping the old list" });
  assert.ok(client.loggedOff);
  assert.deepStrictEqual(JSON.parse(fs.readFileSync(`${output}.json`, "utf8")).applist.apps, last);
});

// Runs the script itself in dir, with a fake steam-user preloaded in place of the real one
function runScript(t, dir, appCount) {
  const preload = path.join(dir, "fake-steam-user.js");
  fs.writeFileSync(preload, `
    const Module = require("node:module");
    const { EventEmitter } = require("node:events");
    class Fake extends EventEmitter {
      logOn() { setImmediate(() => this.emit("loggedOn")); }
      logOff() {}
      async getProductChanges() { return { currentChangeNumber: 1, appChanges: [] }; }
      async getProductInfo(ids) {
        const found = ids.filter((id) => id < ${appCount}).map((id) => [id, { appinfo: { common: { name: "App " + id } } }]);
        return { apps: Object.fromEntries(found) };
      }
    }
    Fake.EMsg = { ClientPICSProductInfoRequest: ${PICS_REQUEST} };
    const load = Module._load;
    Module._load = function (request, ...rest) {
      return request === "steam-user" ? Fake : load.call(this, request, ...rest);
    };
  `);
  return spawnSync(process.execPath, ["--require", preload, SCRIPT], { cwd: dir, encoding: "utf8" });
}

test("run as a program it writes the lists beside it and exits 0, or 1 with the reason", (t) => {
  const dir = path.dirname(tempOutput(t));
  const ok = runScript(t, dir, 3);
  assert.strictEqual(ok.status, 0, ok.stderr);
  assert.strictEqual(fs.readFileSync(path.join(dir, "steamcmd_appid.csv"), "utf8"), '0,"App 0"\n1,"App 1"\n2,"App 2"\n');

  const refused = runScript(t, dir, 1);
  assert.strictEqual(refused.status, 1);
  assert.match(refused.stderr, /Only 1 apps found, against 3 last time/);
});
