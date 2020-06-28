const fs = require('fs');
const path = require('path');
const { CEIType, loadAndroidLibrary } = require('java-mti');

/**
 * @param {string} extensionPath install path of extension
 * @returns {Promise<Map<string,CEIType>>}
 */
async function loadAndroidSystemLibrary(extensionPath) {
    console.time('android-library-load');
    let library;
    try {
        if (!extensionPath) {
            throw new Error('Missing extension path')
        }
        const cache_folder = path.join(extensionPath, 'langserver', '.library-cache');
        library = await loadHighestAPIPlatform(cache_folder);
    } finally {
        console.timeEnd('android-library-load');
    }
    return library;
}

/**
 * @param {string} cache_folder 
 */
async function loadHighestAPIPlatform(cache_folder) {
    /** @type {fs.Dirent[]} */
    const files = await new Promise((res, rej) => {
        fs.readdir(cache_folder, {withFileTypes: true}, (err, files) => err ? rej(err) : res(files));
    });

    // find the file with the highest API level
    let best_match = {
        api: 0,
        /** @type {fs.Dirent} */
        file: null,
    };
    files.forEach(file => {
        const m = file.name.match(/^android-(\d+)\.zip$/);
        if (!m) return;
        const api = parseInt(m[1], 10);
        if (api > best_match.api) {
            best_match = {
                api,
                file,
            }
        }
    });
    if (!best_match.file) {
        throw new Error(`No valid platform cache files found in ${cache_folder}`)
    }
    console.log(`loading android platform cache: ${best_match.file.name}`);

    const cache_file = path.join(cache_folder, best_match.file.name);
    const typemap = loadAndroidLibrary(cache_file);

    return typemap;
}

exports.loadAndroidSystemLibrary = loadAndroidSystemLibrary;
