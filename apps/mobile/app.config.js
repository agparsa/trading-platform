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

/**
 * `EXPO_PUBLIC_API_URL`, when set, replaces the server the app talks to — a
 * local API for the browser preview (`scripts/preview-web.sh`), or a staging
 * host. Unset, the app talks to the one in `app.json`.
 */
function withApiUrl(config, url = process.env.EXPO_PUBLIC_API_URL) {
  if (url === undefined || url === '') return config;
  return { ...config, extra: { ...config.extra, apiBaseUrl: url } };
}

module.exports = ({ config }) => withApiUrl(withFirebase(config, googleServicesFile()));
module.exports.withApiUrl = withApiUrl;
module.exports.googleServicesFile = googleServicesFile;
module.exports.withFirebase = withFirebase;
