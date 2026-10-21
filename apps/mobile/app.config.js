/**
 * The Android Firebase client config, when there is one.
 *
 * An FCM registration token — what `getDevicePushTokenAsync()` returns on
 * Android, and what the server's FCM adapter sends to — can only be issued
 * to an app built with its Firebase project's `google-services.json`. The
 * app had no way to be built with one: push on Android was implemented end
 * to end on the server and could not work on any phone. The first APK
 * handed out for testing said so in its instructions.
 *
 * The file identifies a Firebase project rather than granting anything, but
 * it is still the firm's, not the repository's: it is read from
 * `GOOGLE_SERVICES_JSON` (a path) or `apps/mobile/google-services.json`, which
 * is git-ignored, and an APK built without it says so (`build-android.sh`).
 */
const fs = require('node:fs');
const path = require('node:path');

function googleServicesFile(env = process.env, dir = __dirname) {
  const candidate = env.GOOGLE_SERVICES_JSON || path.join(dir, 'google-services.json');
  return fs.existsSync(candidate) ? path.resolve(candidate) : null;
}

function withFirebase(config, file) {
  if (file === null) return config;
  return { ...config, android: { ...config.android, googleServicesFile: file } };
}

module.exports = ({ config }) => withFirebase(config, googleServicesFile());
module.exports.googleServicesFile = googleServicesFile;
module.exports.withFirebase = withFirebase;
