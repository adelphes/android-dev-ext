
const defaultSettings = {
    appSourceRoot: 'app/src/main',
    codeCompletionLibraries: [],
    trace: false,
}

 class AndroidProjectSettings {
     /**
      * The root of the app source folder.
      * This folder should contain AndroidManifest.xml as well as the asets, res, etc folders
      */
     appSourceRoot = defaultSettings.appSourceRoot;

     /**
      * The set of androidx libraries to include in code completion
      */
     codeCompletionLibraries = defaultSettings.codeCompletionLibraries;

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
         for (let key in defaultSettings) {
            if (Object.prototype.hasOwnProperty.call(values, key)) {
                this[key] = values[key];
            }
         }
     }
 }

exports.Settings = AndroidProjectSettings.Instance;
