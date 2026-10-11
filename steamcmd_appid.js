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

const OUTPUT = "steamcmd_appid";
const BATCH = 20000;
const ATTEMPTS = 5;
const REQUEST_TIMEOUT_MS = 120000;
// Appids above the newest recently changed one that are scanned anyway, and the run of empty
// batches past that which ends the scan.
const MARGIN = 100000;
const EMPTY_BATCHES_TO_STOP = 5;
// A list this much shorter than the last one means Steam answered badly, not that apps vanished.
const MIN_FRACTION_OF_PREVIOUS = 0.9;

function readPrevious() {
  try {
    const apps = JSON.parse(fs.readFileSync(`${OUTPUT}.json`, "utf8")).applist.apps;
    return new Map(apps.map((app) => [app.appid, app.name]));
  } catch {
    return new Map();
  }
}

function withTimeout(promise, what) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${what} timed out`)), REQUEST_TIMEOUT_MS);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

async function retry(what, fn) {
  for (let attempt = 1; ; attempt++) {
    try {
      return await withTimeout(fn(), what);
    } catch (err) {
      if (attempt === ATTEMPTS) throw new Error(`${what} failed ${ATTEMPTS} times: ${err.message}`);
      console.warn(`${what} failed (${err.message}), retrying`);
      await new Promise((resolve) => setTimeout(resolve, 5000 * attempt));
    }
  }
}

async function scan(client, previous) {
  const current = await retry("getProductChanges", () => client.getProductChanges(0));
  const recent = await retry("getProductChanges", () =>
    client.getProductChanges(Math.max(0, current.currentChangeNumber - 3000)));
  let newest = 0;
  for (const appid of [...recent.appChanges.map((change) => change.appid), ...previous.keys()]) {
    newest = Math.max(newest, appid);
  }
  const end = newest + MARGIN;
  console.log(`Scanning appids from 0 past ${end}`);

  const names = new Map();
  let carried = 0;
  let emptyRun = 0;
  for (let start = 0; start < end || emptyRun < EMPTY_BATCHES_TO_STOP; start += BATCH) {
    const ids = Array.from({ length: BATCH }, (_, i) => start + i);
    const info = await retry(`appids ${start}-${start + BATCH - 1}`, () =>
      client.getProductInfo(ids, [], true));
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
    if ((start / BATCH) % 25 === 0) console.log(`  at ${start}: ${names.size} apps`);
  }
  console.log(`Found ${names.size} apps, ${carried} of them named from the previous list`);
  return names;
}

function xmlEscape(text) {
  // Control characters aren't allowed in XML 1.0, even escaped.
  return text
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f￾￿]/g, "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function write(names) {
  const apps = [...names].sort((a, b) => a[0] - b[0]).map(([appid, name]) => ({ appid, name }));

  console.log(`Creating ${OUTPUT}.json`);
  fs.writeFileSync(`${OUTPUT}.json`, `${JSON.stringify({ applist: { apps } }, null, 2)}\n`);

  console.log(`Creating ${OUTPUT}.csv`);
  const csv = apps.map(({ appid, name }) => `${appid},"${name.replace(/"/g, '""')}"\n`);
  fs.writeFileSync(`${OUTPUT}.csv`, csv.join(""));

  console.log(`Creating ${OUTPUT}.xml`);
  const xml = apps.map(({ appid, name }) =>
    `\t\t<app>\n\t\t\t<appid>${appid}</appid>\n\t\t\t<name>${xmlEscape(name)}</name>\n\t\t</app>\n`);
  fs.writeFileSync(`${OUTPUT}.xml`,
    `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE applist>\n<applist>\n\t<apps>\n${xml.join("")}\t</apps>\n</applist>\n`);
}

async function main() {
  const previous = readPrevious();
  const client = new SteamUser();
  client.on("error", (err) => console.warn(`Steam: ${err.message}`));
  const loggedOn = new Promise((resolve) => client.once("loggedOn", resolve));
  client.logOn({ anonymous: true });
  await withTimeout(loggedOn, "Anonymous logon");

  try {
    const names = await scan(client, previous);
    if (names.size < previous.size * MIN_FRACTION_OF_PREVIOUS) {
      throw new Error(`Only ${names.size} apps found, against ${previous.size} last time; keeping the old list`);
    }
    write(names);
  } finally {
    client.logOff();
  }
}

main().then(
  () => process.exit(0),
  (err) => {
    console.error(err.message);
    process.exit(1);
  },
);
