// Expo configures Metro for monorepos (watch folders, node_modules lookup) automatically.
const { getDefaultConfig } = require('expo/metro-config');

module.exports = getDefaultConfig(__dirname);
