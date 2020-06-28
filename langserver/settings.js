
const defaultSettings = {
    appSourceRoot: 'app/src/main',
    trace: false,
}

 class AndroidProjectSettings {
     /**
      * The root of the app source folder.
      * This folder should contain AndroidManifest.xml as well as the asets, res, etc folders
      */
     appSourceRoot = defaultSettings.appSourceRoot;

     /**
      * True if we log details
      */
     trace = defaultSettings.trace;

     updateCount = 0;

     static Instance = new AndroidProjectSettings();

     set(values) {
         if (!values || typeof values !== 'object') {
             return;
         }
         this.updateCount += 1;
        console.log(`settings set: ${JSON.stringify(values)}`);
        for (let key in defaultSettings) {
            if (Object.prototype.hasOwnProperty.call(values, key)) {
                this[key] = values[key];
            }
        }
     }
 }

exports.Settings = AndroidProjectSettings.Instance;
