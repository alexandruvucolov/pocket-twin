// https://docs.expo.dev/guides/customizing-metro/
const { getDefaultConfig } = require("expo/metro-config");

const config = getDefaultConfig(__dirname);

// react-native-webrtc imports event-target-shim/index internally, which isn't
// listed in event-target-shim's "exports" map. Disabling Metro's experimental
// package-exports enforcement silences the warning and uses file-based
// resolution (the correct behaviour) for all packages.
config.resolver.unstable_enablePackageExports = false;

module.exports = config;
