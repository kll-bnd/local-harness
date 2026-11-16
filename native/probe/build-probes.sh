#!/bin/bash
# CI only: build the fact-finding probes into /tmp/probe (uses whatever DEVELOPER_DIR says).
set -e
P=/tmp/probe
mkdir -p $P/SchemeProbe.app/Contents/MacOS
cp native/probe/Info.plist $P/SchemeProbe.app/Contents/Info.plist
swiftc -O -swift-version 5 -target arm64-apple-macos12.0 -o $P/SchemeProbe.app/Contents/MacOS/SchemeProbe native/probe/SchemeProbe.swift -framework AppKit -framework WebKit 2> $P/err1.txt || { tail -n 40 $P/err1.txt; exit 1; }
codesign -s - -f $P/SchemeProbe.app
sed 's/VARIANT_A/VARIANT_B/' native/probe/KeychainProbe.swift > $P/KeychainProbeB.swift
swiftc -O -swift-version 5 -o $P/kcA native/probe/KeychainProbe.swift 2> $P/err2.txt || { tail -n 40 $P/err2.txt; exit 1; }
swiftc -O -swift-version 5 -o $P/kcB $P/KeychainProbeB.swift 2>> $P/err2.txt || { tail -n 40 $P/err2.txt; exit 1; }
codesign -s - -f -i local.harness.probe $P/kcA
codesign -s - -f -i local.harness.probe $P/kcB
# Same two programs, signed ad hoc with an explicit designated requirement that names only the identifier.
cp $P/kcA $P/kcC; cp $P/kcB $P/kcD
codesign -s - -f -i local.harness.probe -r='designated => identifier "local.harness.probe"' $P/kcC
codesign -s - -f -i local.harness.probe -r='designated => identifier "local.harness.probe"' $P/kcD
echo "build| probes built (DEVELOPER_DIR=${DEVELOPER_DIR:-default}); warnings: $(cat $P/err1.txt $P/err2.txt | grep -c warning:)" | tee -a "$FACTS"
