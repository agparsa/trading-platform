#!/usr/bin/env bash
#
# Builds an installable Android APK.
#
# Everything that is a *product* decision — R8, resource shrinking, native
# library compression, locale filters — lives in `app.json` under
# `expo-build-properties`, so `expo prebuild` regenerates it and this script does
# not have to. What is left here is the part that depends on the *machine*: how
# much memory Gradle may take and how many things it may compile at once.
#
# That split matters because `android/` is generated and git-ignored. Anything
# written into it by hand is lost on the next prebuild, which is how build
# knowledge normally evaporates.
#
#   ./scripts/build-android.sh              # arm64 only, for a real phone
#   ABIS=arm64-v8a,x86_64 ./scripts/build-android.sh   # add an emulator
#
set -euo pipefail

cd "$(dirname "$0")/.."

: "${ANDROID_HOME:=/opt/android-sdk}"
export ANDROID_HOME
export ANDROID_SDK_ROOT="${ANDROID_HOME}"

if [ ! -d "${ANDROID_HOME}/platform-tools" ]; then
  echo "No Android SDK at ${ANDROID_HOME}. Set ANDROID_HOME, or install:" >&2
  echo "  sdkmanager 'platform-tools' 'platforms;android-36' 'build-tools;36.0.0' 'cmake;3.22.1'" >&2
  echo "The NDK installs itself on first build — Gradle names the version it wants." >&2
  exit 1
fi

# One ABI by default. Every phone made in the last several years is arm64, and
# building the other three multiplies the C++ compile for nobody who will
# install this.
ABIS="${ABIS:-arm64-v8a}"

echo "==> Generating the native project"
npx expo prebuild --platform android --no-install

echo "==> Tuning for this machine"
CORES="$(nproc 2>/dev/null || sysctl -n hw.ncpu 2>/dev/null || echo 2)"
MEM_GB="$(free -g 2>/dev/null | awk '/^Mem:/{print $2}' || echo 8)"

python3 - "$ABIS" "$CORES" "$MEM_GB" <<'PY'
import sys, pathlib

abis, cores, mem_gb = sys.argv[1], int(sys.argv[2]), int(sys.argv[3])
properties = pathlib.Path('android/gradle.properties')
text = properties.read_text()

def put(key: str, value: str) -> None:
    global text
    lines = [line for line in text.splitlines() if not line.startswith(f'{key}=')]
    lines.append(f'{key}={value}')
    text = '\n'.join(lines) + '\n'

put('reactNativeArchitectures', abis)

# Gradle's heap and the native compile do not share a machine well. The first
# attempt at this build gave the JVM 4 GB on a 7 GB box and left parallel
# execution on; the daemon was killed mid-C++-compile by the OOM killer, and
# the error Gradle reports for that — "daemon disappeared unexpectedly" — says
# nothing about memory.
# A third of the machine, capped. The arithmetic matters: an earlier version of
# this line computed 4096m on a 7 GB box — which is precisely the heap that got
# the daemon OOM-killed when this was first built by hand. Native compilation
# needs the rest, and Gradle asking for "what is left over" is how it ends up
# fighting the compiler it just started.
heap = max(1536, min(3072, (mem_gb * 1024) // 3))
put('org.gradle.jvmargs', f'-Xmx{heap}m -XX:MaxMetaspaceSize=512m')
put('org.gradle.parallel', 'true' if cores >= 4 and mem_gb >= 12 else 'false')
put('org.gradle.workers.max', str(max(1, min(cores - 1, 4))) if mem_gb >= 12 else '1')
put('org.gradle.daemon', 'false')
put('org.gradle.caching', 'true')

properties.write_text(text)
print(f'  {cores} cores, {mem_gb} GB → heap {heap}m, abis {abis}')
PY

echo "==> Building"
cd android
# Ninja gets one job on a small machine for the same reason Gradle gets one
# worker: the C++ compile is what runs the box out of memory.
export CMAKE_BUILD_PARALLEL_LEVEL="${CMAKE_BUILD_PARALLEL_LEVEL:-1}"
./gradlew :app:assembleRelease --no-daemon --console=plain

APK="app/build/outputs/apk/release/app-release.apk"
[ -f "$APK" ] || { echo "No APK at $APK" >&2; exit 1; }

echo "==> Verifying"
BUILD_TOOLS="$(ls -d "${ANDROID_HOME}"/build-tools/* | sort -V | tail -1)"
"${BUILD_TOOLS}/apksigner" verify "$APK"

# Listings are captured before they are searched, deliberately.
#
# `unzip -l "$APK" | grep -q ...` looks right and fails under `set -o pipefail`:
# `grep -q` exits at the first match, `unzip` takes SIGPIPE, and the pipeline
# reports failure for a check that *passed*. The first version of this script
# did exactly that and declared a present bundle missing.
CONTENTS="$(unzip -l "$APK")"
RESOURCES="$("${BUILD_TOOLS}/aapt2" dump resources "$APK" 2>/dev/null || true)"

# The JS bundle must be inside, or the app looks for a Metro server that is not
# there and shows a red screen on a phone that has no developer running.
case "$CONTENTS" in
  *assets/index.android.bundle*) ;;
  *) echo "The JS bundle is missing from the APK." >&2; exit 1 ;;
esac

# Both naming schemes matter. `raw/trade_opened` is what a notification channel
# resolves; `raw/assets_sounds_trade_opened` is what the in-app player's
# require() resolves. A channel naming a resource that is not there is delivered
# **silently** on Android 8 and later, which is the quietest possible failure
# for a margin call.
for name in trade_opened trade_closed trade_modified order_filled order_cancelled stop_loss take_profit risk_warning; do
  case "$RESOURCES" in
    *"raw/${name}"$'\n'*) ;;
    *) echo "Notification sound ${name} is missing from res/raw." >&2; exit 1 ;;
  esac
  case "$RESOURCES" in
    *"raw/assets_sounds_${name}"*) ;;
    *) echo "In-app sound asset ${name} is missing from res/raw." >&2; exit 1 ;;
  esac
done

echo
echo "$(cd .. && pwd)/android/${APK}"
ls -la "$APK" | awk '{printf "%.2f MiB\n", $5/1048576}'
