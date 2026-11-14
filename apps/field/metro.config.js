// Monorepo: the web app hoists react 19.3.1 to the root, but react-native 0.88 needs the exact
// react this app declares. Force every `react` import to this app's copy.
const { getDefaultConfig } = require('expo/metro-config');
const path = require('node:path');

const projectRoot = __dirname;
const workspaceRoot = path.resolve(projectRoot, '../..');
const config = getDefaultConfig(projectRoot);

config.watchFolders = [workspaceRoot];
config.resolver.nodeModulesPaths = [
  path.resolve(projectRoot, 'node_modules'),
  path.resolve(workspaceRoot, 'node_modules'),
];
config.resolver.extraNodeModules = { react: path.resolve(projectRoot, 'node_modules/react') };

module.exports = config;
