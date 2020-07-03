const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const { extractManifestFromAPK, parseManifest } = require('./manifest');
const { D } = require('./utils/print');

class APKFileInfo {
    /**
     * the full file path to the APK file
     */
    fpn = '';

    /**
     * The APK file data
     * @type {Buffer}
     */
    file_data = null;

    /**
     * The size of the APK file (in bytes)
     */
    file_size = 0;

    /**
     * last modified time of the APK file (in ms)
     */
    app_modified = 0;

    /**
     * SHA-1 (hex) digest of the APK file
     */
    content_hash = '';

    /**
     * Contents of Android Manifest XML file
     */
    manifestXml = '';

    /**
     * Extracted data from the manifest
     */
    manifest = {
        /**
         * Package name of the app
         */
        package: '',

        /**
         * List of all named Activities
         * @type {string[]}
         */
        activities: [],

        /**
         * The launcher Activity
         */
        launcher: '',
    };

    constructor(apk_fpn) {
        this.fpn = apk_fpn;
    }

    /**
     * Build a new APKFileInfo instance
     * @param {*} args
     */
    static async from(args) {
        const result = new APKFileInfo(args.apkFile);

        // read the APK file contents
        try {
            result.file_data = await readFile(args.apkFile);
            result.file_size = result.file_data.length;
        } catch(err) {
            throw new Error(`APK read error. ${err.message}`);
        }
        // save the last modification time of the app
        result.app_modified = fs.statSync(result.fpn).mtime.getTime();

        // create a SHA-1 hash as a simple way to see if we need to install/update the app
        const h = crypto.createHash('SHA1');
        h.update(result.file_data);
        result.content_hash = h.digest('hex');

        // read the manifest
        try {
            result.manifestXml = await getAndroidManifestXml(args);
        } catch (err) {
            throw new Error(`Manifest read error. ${err.message}`);
        }
        // extract the parts we need from the manifest
        try {
            result.manifest = parseManifest(result.manifestXml);
        } catch(err) {
            throw new Error(`Manifest parse failed. ${err.message}`);
        }
        return result;
    }
}

/**
 * Retrieve the AndroidManifest.xml file content
 * 
 *   Because of manifest merging and build-injected properties, the manifest compiled inside
 *   the APK is frequently different from the AndroidManifest.xml source file.
 *   We try to extract the manifest from 3 sources (in priority order):
 *   1. The 'manifestFile' launch configuration property
 *   2. The decoded manifest from the APK
 *   3. The AndroidManifest.xml file from the root of the source tree.
 */
async function getAndroidManifestXml({manifestFile, apkFile, appSrcRoot}) {
    let manifest;

    // a value from the manifestFile overrides the default manifest extraction
    // note: there's no validation that the file is a valid AndroidManifest.xml file
    if (manifestFile) {
        D(`Reading manifest from ${manifestFile}`);
        manifest = await readFile(manifestFile, 'utf8');
        return manifest;
    }

    try {
        D(`Reading APK Manifest`);
        manifest = await extractManifestFromAPK(apkFile);
    } catch(err) {
        // if we fail to get manifest from the APK, revert to the source file version
        D(`Reading source manifest from ${appSrcRoot} (${err.message})`);
        manifest = await readFile(path.join(appSrcRoot, 'AndroidManifest.xml'), 'utf8');
    }
    return manifest;
}

/**
 * Promisified fs.readFile()
 * @param {string} path 
 * @param {*} [options] 
 */
function readFile(path, options) {
	return new Promise((res, rej) => {
		fs.readFile(path, options || {}, (err, data) => {
			err ? rej(err) : res(data);
		})
	})
}

module.exports = {
    APKFileInfo,
}
