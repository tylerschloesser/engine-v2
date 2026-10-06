#!/bin/bash
# Leg B: process list, kill/launch Safari and a screenshot, all via pymobiledevice3 (no signing, no sudo; userspace tunnel fallback).
D() { pymobiledevice3 developer dvt "$@" 2>&1 | grep -v WARNING; }
OUT=${1:-.}
echo "safari pid: $(D process-id-for-bundle-id com.apple.mobilesafari)"
echo "proclist rows: $(D proclist | wc -l)"; D proclist | grep -i -m3 mobilesafari | cut -c1-200
echo "-- kill"; D kill "$(D process-id-for-bundle-id com.apple.mobilesafari)"; sleep 1
echo "safari pid after kill: '$(D process-id-for-bundle-id com.apple.mobilesafari)'"
echo "-- launch Settings then Safari"; D launch com.apple.Preferences; sleep 2; D launch com.apple.mobilesafari; sleep 3
echo "safari pid: $(D process-id-for-bundle-id com.apple.mobilesafari)"
D screenshot "$OUT/b-after-launch.png"
