const fs = require('fs');
const dom = require('xmldom').DOMParser;
const unzipper = require('unzipper');
const xpath = require('xpath');

const { decode_binary_xml } = require('./apkdecoder');

/**
 * Extracts and decodes the compiled AndroidManifest.xml from an APK
 * @param {string} apk_fpn file path to APK
 * @returns {Promise<string>}
 */
function extractManifestFromAPK(apk_fpn) {
    return new Promise((resolve, reject) => {
        extractFileFromAPK(apk_fpn, /^AndroidManifest\.xml$/, onExtractComplete);

        function onExtractComplete(err, data) {
            let manifest;
            if (!err) {
                try {
                    manifest = decode_binary_xml(data);
                } catch (e) {
                    err = e;
                }
            }
            err ? reject(err) : resolve(manifest);
        }
    });
}


/**
 * Extracts a single file from an APK
 * @param {string} apk_fpn 
 * @param {RegExp} file_match 
 * @param {(err,data) => void} cb 
 */
function extractFileFromAPK(apk_fpn, file_match, cb) {
    const file_chunks = [];
    let cb_once = (err, data) => {
        cb_once = () => {};
        cb(err, data)
    }
    fs.createReadStream(apk_fpn)
        .pipe(unzipper.ParseOne(file_match))
        .on('data', chunk => {
            file_chunks.push(chunk);
        })
        .once('error', err => {
            cb_once(err);
        })
        .once('end', () => {
            cb_once(null, Buffer.concat(file_chunks));
        });
}


/**
 * Parses a manifest file to extract package, activities and launch activity
 * @param {string} xml AndroidManifest XML text
 */
function parseManifest(xml) {
    const result = {
        /**
         * The package name
         */
        package: '',
        /**
         * the list of Activities stored in the manifest
         * @type {string[]}
         */
        activities: [],
        /**
         * the name of the Activity with:
         *   - intent-filter action = android.intent.action.MAIN and
         *   - intent-filter category = android.intent.category.LAUNCHER
         */
        launcher: '',
    }
    const doc = new dom().parseFromString(xml);
    // extract the package name from the manifest
    const pkg_xpath = '/manifest/@package';
    result.package = xpath.select1(pkg_xpath, doc).value;
    const android_select = xpath.useNamespaces({"android": "http://schemas.android.com/apk/res/android"});
    
    // extract a list of all the (named) activities declared in the manifest
    const activity_xpath = '/manifest/application/activity/@android:name';
    const activity_nodes = android_select(activity_xpath, doc);
    if (activity_nodes) {
        result.activities = activity_nodes.map(n => n.value);
    }

    // extract the default launcher activity
    const launcher_xpath = '/manifest/application/activity[intent-filter/action[@android:name="android.intent.action.MAIN"] and intent-filter/category[@android:name="android.intent.category.LAUNCHER"]]/@android:name';
    const launcher_nodes = android_select(launcher_xpath, doc);
    // should we warn if there's more than one?
    if (launcher_nodes && launcher_nodes.length >= 1) {
        result.launcher = launcher_nodes[0].value
    }

    return result;
}

module.exports = {
    extractManifestFromAPK,
    parseManifest,
}
