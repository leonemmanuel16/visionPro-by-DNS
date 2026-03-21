#!/bin/sh
cd /Users/emmanuelleon/dns-vision-ai/services/dashboard
exec /Users/emmanuelleon/local/node-v20.11.1-darwin-arm64/bin/node node_modules/.bin/next dev --port "${PORT:-3000}"
