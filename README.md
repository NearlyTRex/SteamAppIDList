# SteamCMD AppID List

<p align="center">
  <a href="https://developer.valvesoftware.com/wiki/SteamCMD"><img src="https://user-images.githubusercontent.com/4478206/197542699-ae13797a-78bb-4f37-81c2-d4880fd7709f.jpg" alt="SteamCMD"></a>
<br>
</p>
<p align="center">
<a href="https://github.com/NearlyTRex/SteamAppIDList/actions"><img alt="GitHub Workflow Status" src="https://img.shields.io/github/actions/workflow/status/NearlyTRex/SteamAppIDList/generate_output.yml?logo=github&style=flat-square&logoColor=white">
<a href="https://developer.valvesoftware.com/wiki/SteamCMD"><img src="https://img.shields.io/badge/SteamCMD-000000?style=flat-square&logo=Steam&logoColor=white" alt="SteamCMD"></a>
<a href="https://nodejs.org"><img src="https://img.shields.io/badge/Made with Node.js-339933?style=flat-square&logo=nodedotjs&logoColor=white" alt="Node.js"></a>
<a href="https://github.com/NearlyTRex/SteamAppIDList/blob/main/LICENSE.md"><img src="https://img.shields.io/github/license/NearlyTRex/SteamAppIDList?style=flat-square" alt="MIT License"></a>
</p>

## Description

This repo stores every `AppID` and its name available on Steam as `json`, `CSV` and `xml`,
dedicated servers and other tools included.

Valve removed the `ISteamApps/GetAppList` Web API this list used to come from, and its
replacement needs an API key and leaves out tools such as dedicated servers. So the script logs
in to Steam anonymously, as SteamCMD does, and reads every app's name from Steam's product info
(PICS). A full run takes about ten minutes.

## List

You can get the output without using the script.

[steamcmd_appid.json](https://github.com/NearlyTRex/SteamAppIDList/blob/main/steamcmd_appid.json)

[steamcmd_appid.csv](https://github.com/NearlyTRex/SteamAppIDList/blob/main/steamcmd_appid.csv)

[steamcmd_appid.xml](https://github.com/NearlyTRex/SteamAppIDList/blob/main/steamcmd_appid.xml)

> GitHub Actions rebuilds the list daily and commits it here when it changes.

## Usage

Clone the repo and run the script. It needs [Node.js](https://nodejs.org) 20 or newer.

```bash
git clone https://github.com/NearlyTRex/SteamAppIDList.git
cd SteamAppIDList
./steamcmd_appid.sh
```
