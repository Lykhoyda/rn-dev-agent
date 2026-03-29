import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
const KEY_DEPS = [
    '@tanstack/react-query',
    'zustand',
    'nativewind',
    '@react-navigation/native',
    'expo-router',
    '@shopify/flash-list',
    'react-native-reanimated',
    'react-native-gesture-handler',
    'redux',
    '@reduxjs/toolkit',
    'react-hook-form',
    'react-native-mmkv',
];
function readJson(path) {
    try {
        if (!existsSync(path))
            return null;
        return JSON.parse(readFileSync(path, 'utf-8'));
    }
    catch {
        return null;
    }
}
function findProjectRoot() {
    let dir = process.cwd();
    for (let i = 0; i < 10; i++) {
        if (existsSync(join(dir, 'package.json')))
            return dir;
        const parent = join(dir, '..');
        if (parent === dir)
            break;
        dir = parent;
    }
    return null;
}
function extractVersion(deps, name) {
    const ver = deps[name];
    if (typeof ver === 'string')
        return ver.replace(/^[\^~>=<]/, '');
    return null;
}
function extractKeyDeps(allDeps) {
    const found = [];
    for (const dep of KEY_DEPS) {
        const ver = extractVersion(allDeps, dep);
        if (ver) {
            const major = ver.split('.')[0];
            found.push(`${dep}@${major}.x`);
        }
    }
    return found;
}
export function captureFingerprint() {
    let root = null;
    try {
        root = findProjectRoot();
    }
    catch { /* cwd gone */ }
    const fp = {
        rn_version: null,
        expo_sdk: null,
        engine: null,
        architecture: null,
        bridgeless: null,
        platform: null,
        device: null,
        metro_port: 8081,
        key_deps: [],
    };
    if (!root)
        return fp;
    const pkg = readJson(join(root, 'package.json'));
    if (!pkg)
        return fp;
    const allDeps = {
        ...(pkg.dependencies || {}),
        ...(pkg.devDependencies || {}),
    };
    fp.rn_version = extractVersion(allDeps, 'react-native');
    fp.expo_sdk = extractVersion(allDeps, 'expo');
    fp.key_deps = extractKeyDeps(allDeps);
    fp.engine = allDeps['hermes-engine'] ? 'hermes' : (allDeps['jsc-android'] ? 'jsc' : 'hermes');
    const appJson = readJson(join(root, 'app.json'));
    if (appJson) {
        const expo = appJson.expo;
        if (expo) {
            const newArch = expo.newArchEnabled;
            if (typeof newArch === 'boolean') {
                fp.architecture = newArch ? 'fabric' : 'old';
                fp.bridgeless = newArch;
            }
            const platforms = expo.platforms;
            if (platforms?.length === 1) {
                fp.platform = platforms[0];
            }
        }
    }
    return fp;
}
