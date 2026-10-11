#!/bin/bash
# steamcmd_appid.sh
# Description: Saves the complete list of all the appids and their names in json, csv and xml.
# Needs Node.js 20 or newer. See steamcmd_appid.js for how the list is built.

set -euo pipefail
cd "$(dirname "$0")"
npm ci --silent
node steamcmd_appid.js
