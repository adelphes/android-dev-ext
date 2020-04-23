const fs = require('fs');
const path = require('path');

const { ADBClient } = require('../adbclient');
const ADBSocket = require('../sockets/adbsocket');
const { LOG } = require('../utils/print');

function getAndroidSDKFolder() {
    // ANDROID_HOME is deprecated
    return process.env.ANDROID_HOME || process.env.ANDROID_SDK;
}

/**
 * @param {string} api_level 
 * @param {boolean} check_is_dir
 */
function getAndroidSourcesFolder(api_level, check_is_dir) {
    const android_sdk = getAndroidSDKFolder();
    if (!android_sdk) {
        return null;
    }
    const sources_path = path.join(android_sdk,'sources',`android-${api_level}`);
    if (check_is_dir) {
        try {
            const stat = fs.statSync(sources_path);
            if (!stat || !stat.isDirectory()) {
                return null;
            }
        } catch {
            return null;
        }
    }
    return sources_path;
}

function getADBPathName() {
    const android_sdk = getAndroidSDKFolder();
    if (!android_sdk) {
        return '';
    }
    return path.join(android_sdk, 'platform-tools', /^win/.test(process.platform)?'adb.exe':'adb');    
}

/**
 * @param {number} port 
 */
function startADBServer(port) {
    if (typeof port !== 'number' || port <= 0 || port >= 65536) {
        return false;
    }
    
    const adb_exe_path = getADBPathName();
    if (!adb_exe_path) {
        return false;
    }
    const adb_start_server_args = ['-P',`${port}`,'start-server'];
    try {
        LOG([adb_exe_path, ...adb_start_server_args].join(' '));
        const stdout = require('child_process').execFileSync(adb_exe_path, adb_start_server_args, {
            cwd: getAndroidSDKFolder(),
            encoding:'utf8',
        });
        LOG(stdout);
        return true;
    } catch (ex) {} // if we fail, it doesn't matter - the device query will fail and the user will have to work it out themselves
    return false
}

/**
 * @param {boolean} auto_start 
 */
async function checkADBStarted(auto_start) {
    const err = await new ADBClient().test_adb_connection();
    // if adb is not running, see if we can start it ourselves using ANDROID_HOME (and a sensible port number)
    if (err && auto_start) {
        return startADBServer(ADBSocket.ADBPort);
    }
    return !err;
}

module.exports = {
    checkADBStarted,
    getADBPathName,
    getAndroidSDKFolder,
    getAndroidSourcesFolder,
    startADBServer,
}
