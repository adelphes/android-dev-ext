/**
 * 1. Download the latest platform and source
 * ./android-sdk/cmdline-tools/bin/sdkmanager --sdk_root=$ANDROID_SDK_ROOT --install 'platforms;android-30'
 * ./android-sdk/cmdline-tools/bin/sdkmanager --sdk_root=$ANDROID_SDK_ROOT --install 'sources;android-30'
 *
 * 2. Run this file, passing in the android API version
 * node library-cache.js android-30
 * 
 * 3. To create the final shipped data, move the JSON into a 'cache' folder and zip
 * mkdir cache
 * mv android-30.json cache
 * zip -9 -r android-30.zip cache
 */

const path = require('path');
const { createAndroidLibraryCacheFile } = require('java-mti/android-library');

/**
 * @param {`android-${number}`} api
 */
async function buildLibraryCache(api) {
  // `createAndroidLibraryCacheFile()` just creates the JSON (not the zipped version)
  const cache_filename = path.join(__dirname, '.library-cache', `${api}.json`);
  await createAndroidLibraryCacheFile(cache_filename, { api });
}

const api = process.argv[2];
if (!api) throw new Error('android api parameter expected');

buildLibraryCache(api);
