const fs = require('fs');
const path = require('path');
const { loadAndroidLibrary, CEIType } = require('java-mti');

const android_system_library_cache_filename = {
    regex: /^sdk-platforms-android-(.+?)-(\d+)\.json$/,
    /**
     * @param {string} version
     * @param {fs.Stats} stat 
     */
    build(version, stat) {
        return `sdk-platforms-${version}-${Math.trunc(stat.mtime.getTime())}.json`;
    }
}

/**
 * @param {string} cache_dir directory used to store decoded jar libraries
 */
function ensureFolderExists(cache_dir) {
    if (!cache_dir) {
        throw new Error('missing cache dir value');
    }
    try {
        const stat = fs.statSync(cache_dir);
        if (!stat.isDirectory()) {
            throw new Error(`cache dir '${cache_dir}' is not a directory`);
        }
    } catch (err) {
        if (err.code !== 'ENOENT') {
            throw new Error(`cache dir '${cache_dir}' check failed: ${err.message}`);
        }
        fs.mkdirSync(cache_dir);
    }
}

/**
 * 
 * @param {string} cache_dir 
 * @param {RegExp} filter 
 * @returns {fs.Dirent[]}
 */
function findLibraryFiles(cache_dir, filter) {
    const files = fs.readdirSync(cache_dir, { withFileTypes: true });
    const valid_files = files.filter(file =>  filter.test(file.name) && file.isFile());
    return valid_files;
}

/**
 * 
 * @param {fs.Dirent[]} files 
 */
function chooseAndroidSystemLibrary(files) {
    let chosen = {
        api: 0,
        /** @type {fs.Dirent} */
        file: null,
    };
    files.forEach(file => {
        const m = file.name.match(android_system_library_cache_filename.regex);
        if (!m) return;
        if (/^\d+$/.test(m[1])) {
            const api = parseInt(m[1]);
            if (api > chosen.api) {
                chosen.api = api;
                chosen.file = file;
            }
        }
    })
    return chosen.file;
}

function findHighestAPISystemLibrary(android_sdk_platforms_root) {
    let platform_folders = [], android_platform_jars = [];
    try {
        platform_folders = fs.readdirSync(android_sdk_platforms_root, { withFileTypes: true });
    } catch {};
    platform_folders.forEach(folder => {
        if (!folder.isDirectory()) return;
        // we assume stable SDK platform folders are named 'android-<api-level>'
        if (!/^android-\d+$/.test(folder.name)) return;
        // the platform folder must contain an android.jar file
        let stat, filepath = path.join(android_sdk_platforms_root, folder.name, 'android.jar');
        try { stat = fs.statSync(filepath) }
        catch { return }
        if (!stat.isFile()) return;
        // add it to the list
        android_platform_jars.push({
            folder: folder.name,
            api: parseInt(folder.name.split('-')[1], 10),
            filepath,
            stat,
        })
    });
    if (android_platform_jars.length === 0) {
        return null;
    }
    // choose the folder with the highest API number
    return android_platform_jars.sort((a,b) => b.api - a.api)[0].folder;
}

/**
 * @param {string} cache_dir
 * @param {string|':latest'} [version] 
 */
async function buildAndroidSystemLibrary(cache_dir, version) {
    const android_sdk_root = process.env['ANDROID_SDK'] || process.env['ANDROID_HOME'];
    if (!android_sdk_root) {
        throw new Error('Cannot locate Android SDK folder - ANDROID_SDK env variable is not defined');
    }
    const android_sdk_platforms_root = path.join(android_sdk_root, 'platforms');

    if (!version) {
        // choose the folder with the highest API number
        version = findHighestAPISystemLibrary(android_sdk_platforms_root);
        if (!version) {
            throw new Error(`Cannot build Android library: No supported system libraries found in ${android_sdk_platforms_root}`);
        }
    }

    let stat, filepath = path.join(android_sdk_platforms_root, version, 'android.jar');
    try { stat = fs.statSync(filepath) }
    catch { }
    if (!stat || !stat.isFile()) {
        throw new Error(`Cannot build Android library: '${filepath}' is not a valid android system library file`);
    }

    console.log(`Building ${version} library cache for code completion support. This might take a few minutes...`);
    const cache_filename = path.join(cache_dir, android_system_library_cache_filename.build(version, stat));
    try {
        const library = await loadAndroidLibrary(cache_filename, { api: version, sdk_root: android_sdk_root });
        console.log(`${version} library cache built.`);
        return library;
    } catch(err) {
        throw new Error(`Cannot build Android library: ${err.message}`);
    }
}

/**
 * @param {string} cache_dir directory used to store decoded jar libraries
 * @returns {Promise<Map<string,CEIType>>}
 */
async function loadAndroidSystemLibrary(cache_dir) {
    console.time('android-library-load');
    // for (let x;;) {
    //     console.log('waiting');
    //     if (x) break;
    //     await new Promise(res => setTimeout(res, 1000));
    // }
    let library;
    try {
        ensureFolderExists(cache_dir);
        const library_files = findLibraryFiles(cache_dir, android_system_library_cache_filename.regex);
        if (!library_files.length) {
            return buildAndroidSystemLibrary(cache_dir);
        }
        // search for the highest android API number in the list of cached files
        const library_file = chooseAndroidSystemLibrary(library_files);
        if (!library_file) {
            return buildAndroidSystemLibrary(cache_dir);
        }
        // load the library
        const library_path_name = path.join(cache_dir, library_file.name);
        console.log(`Loading android system library: ${library_path_name}`);
        library = await loadAndroidLibrary(library_path_name, null);

    } catch (err) {
        console.error(`android library load failed: ${err.message}`);
        library = new Map();
    }
    console.timeEnd('android-library-load');
    return library;
}

exports.loadAndroidSystemLibrary = loadAndroidSystemLibrary;
