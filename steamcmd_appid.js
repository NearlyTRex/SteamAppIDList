#!/usr/bin/env node
// steamcmd_appid.js
// Description: Saves the complete list of all the appids and their names in json, csv and xml.
//
// Valve removed ISteamApps/GetAppList, and its replacement (IStoreService/GetAppList) needs an
// API key and leaves out tools such as dedicated servers. So this logs in to Steam anonymously,
// as SteamCMD does, and asks PICS for the info of every appid up to the newest one. Steam keeps
// only a few hours of change history, too little to update the list incrementally.

const fs = require("fs");
const SteamUser = require("steam-user");

const DEFAULTS = {
  // Where the lists are written, without the extension
  output: "steamcmd_appid",
  batch: 20000,
  attempts: 5,
  timeoutMs: 120000,
  // The wait before a retry, times the attempt that failed
  retryDelayMs: 5000,
  // Appids above the newest recently changed one that are scanned anyway, and the run of empty
  // batches past that which ends the scan.
  margin: 100000,
  emptyBatchesToStop: 5,
  // A list this much shorter than the last one means Steam answered badly, not that apps vanished.
  minFractionOfPrevious: 0.9,
};

// Steam now sends some apps in a PICS product info response with no info at all, and steam-user
// 5.3.0 calls toString() on the missing buffer, throwing from its message handler where no retry
// can catch it. This hands such apps an empty appinfo block instead, before steam-user reads them;
// scan() then treats them like any other app without a name.
const EMPTY_APPINFO = Buffer.from('"appinfo"\n{\n}\n');

function patchEmptyApps(client) {
  const send = client._send;
  client._send = function (emsgOrHeader, body, callback) {
    const emsg = typeof emsgOrHeader === "object" ? emsgOrHeader.msg : emsgOrHeader;
    if (emsg !== SteamUser.EMsg.ClientPICSProductInfoRequest || !callback) {
      return send.call(this, emsgOrHeader, body, callback);
    }
    return send.call(this, emsgOrHeader, body, function (response, ...rest) {
      for (const app of response?.apps ?? []) {
        if (!app.buffer) app.buffer = EMPTY_APPINFO;
      }
      return callback.call(this, response, ...rest);
    });
  };
}

function readPrevious(output) {
  try {
    const apps = JSON.parse(fs.readFileSync(`${output}.json`, "utf8")).applist.apps;
    return new Map(apps.map((app) => [app.appid, app.name]));
  } catch {
    return new Map();
  }
}

function withTimeout(promise, what, timeoutMs) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${what} timed out`)), timeoutMs);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

async function retry(what, fn, options) {
  for (let attempt = 1; ; attempt++) {
    try {
      return await withTimeout(fn(), what, options.timeoutMs);
    } catch (err) {
      if (attempt === options.attempts) {
        throw new Error(`${what} failed ${options.attempts} times: ${err.message}`);
      }
      console.warn(`${what} failed (${err.message}), retrying`);
      await new Promise((resolve) => setTimeout(resolve, options.retryDelayMs * attempt));
    }
  }
}

async function scan(client, previous, options) {
  const { batch } = options;
  const current = await retry("getProductChanges", () => client.getProductChanges(0), options);
  const recent = await retry("getProductChanges", () =>
    client.getProductChanges(Math.max(0, current.currentChangeNumber - 3000)), options);
  let newest = 0;
  for (const appid of [...recent.appChanges.map((change) => change.appid), ...previous.keys()]) {
    newest = Math.max(newest, appid);
  }
  const end = newest + options.margin;
  console.log(`Scanning appids from 0 past ${end}`);

  const names = new Map();
  let carried = 0;
  let emptyRun = 0;
  for (let start = 0; start < end || emptyRun < options.emptyBatchesToStop; start += batch) {
    const ids = Array.from({ length: batch }, (_, i) => start + i);
    const info = await retry(`appids ${start}-${start + batch - 1}`, () =>
      client.getProductInfo(ids, [], true), options);
    const found = Object.entries(info.apps);
    emptyRun = found.length ? 0 : emptyRun + 1;
    for (const [id, app] of found) {
      const appid = Number(id);
      const name = app.appinfo?.common?.name;
      if (name !== undefined) {
        names.set(appid, name);
      } else if (previous.has(appid)) {
        // The app exists, but its info needs an access token an anonymous login can't get.
        names.set(appid, previous.get(appid));
        carried++;
      }
      // steam-user keeps each request's callback, and so its response, for two minutes. Emptying
      // the response here stops a minute and more of batches piling up in memory.
      delete app.appinfo;
      delete info.apps[id];
    }
    if ((start / batch) % 25 === 0) console.log(`  at ${start}: ${names.size} apps`);
  }
  console.log(`Found ${names.size} apps, ${carried} of them named from the previous list`);
  return names;
}

function xmlEscape(text) {
  // Control characters aren't allowed in XML 1.0, even escaped.
  return text
    // eslint-disable-next-line no-control-regex -- matching them is the point
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f￾￿]/g, "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function write(names, output) {
  const apps = [...names].sort((a, b) => a[0] - b[0]).map(([appid, name]) => ({ appid, name }));

  console.log(`Creating ${output}.json`);
  fs.writeFileSync(`${output}.json`, `${JSON.stringify({ applist: { apps } }, null, 2)}\n`);

  console.log(`Creating ${output}.csv`);
  const csv = apps.map(({ appid, name }) => `${appid},"${name.replace(/"/g, '""')}"\n`);
  fs.writeFileSync(`${output}.csv`, csv.join(""));

  console.log(`Creating ${output}.xml`);
  const xml = apps.map(({ appid, name }) =>
    `\t\t<app>\n\t\t\t<appid>${appid}</appid>\n\t\t\t<name>${xmlEscape(name)}</name>\n\t\t</app>\n`);
  fs.writeFileSync(`${output}.xml`,
    `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE applist>\n<applist>\n\t<apps>\n${xml.join("")}\t</apps>\n</applist>\n`);
}

// Builds the lists. overrides replaces any of DEFAULTS, and client a logged-off SteamUser.
async function main(overrides = {}, client = new SteamUser()) {
  const options = { ...DEFAULTS, ...overrides };
  const previous = readPrevious(options.output);
  patchEmptyApps(client);
  client.on("error", (err) => console.warn(`Steam: ${err.message}`));
  const loggedOn = new Promise((resolve) => client.once("loggedOn", resolve));
  client.logOn({ anonymous: true });
  await withTimeout(loggedOn, "Anonymous logon", options.timeoutMs);

  try {
    const names = await scan(client, previous, options);
    if (names.size < previous.size * options.minFractionOfPrevious) {
      throw new Error(`Only ${names.size} apps found, against ${previous.size} last time; keeping the old list`);
    }
    write(names, options.output);
  } finally {
    client.logOff();
  }
}

module.exports = { DEFAULTS, patchEmptyApps, readPrevious, withTimeout, retry, scan, xmlEscape, write, main };

// steam-user keeps the connection's timers alive after logOff, so the run ends with an exit.
if (require.main === module) {
  main().then(
    () => process.exit(0),
    (err) => {
      console.error(err.message);
      process.exit(1);
    },
  );
}
