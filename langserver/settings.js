
const defaultSettings = {
    appRoot: 'app/src/main'
}

 class AndroidProjectSettings {
     /**
      * The root of the app source folder.
      * This folder should contain AndroidManifest.xml as well as the asets, res, etc folders
      */
     appRoot = defaultSettings.appRoot;

     /**
      * The identifier for the language server settings
      */
     ID = 'androidJavaLanguageServer';

     static Instance = new AndroidProjectSettings();

     /**
      * Called when the user edits the settings
      * @param {*} values 
      */
     onChange(values) {
         this.set(values);
     }

     set(values) {
        console.log(`settings set: ${JSON.stringify(values)}`);
        for (let key in defaultSettings) {
            if (Object.prototype.hasOwnProperty.call(values, key)) {
                this[key] = values[key];
            }
        }
     }
 }


// function getDocumentSettings(resource) {
//     if (!hasConfigurationCapability) {
//         return Promise.resolve(projectSettings);
//     }
//     let result = documentSettings.get(resource);
//     if (!result) {
//         result = connection.workspace.getConfiguration({
//             scopeUri: resource,
//             section: 'androidJavaLanguageServer',
//         });
//         documentSettings.set(resource, result);
//     }
//     return result;
// }

exports.Settings = AndroidProjectSettings.Instance;
