# Android for VS Code

This is a preview version of the Android for VS Code Extension. The extension allows developers to install, launch and debug Android Apps from
within the VS Code environment.

## Requirements

You must have [Android SDK Tools](https://developer.android.com/studio/releases/sdk-tools.html) installed. This extension communicates with your device via the ADB (Android Debug Bridge) interface.  
> You are not required to have Android Studio installed - if you have Android Studio installed, make sure there are no active instances of it when using this 
extension or you may run into problems with ADB.

## Limitations

* This is a preview version so expect the unexpected. Please log any issues you find on [GitHub](https://github.com/adelphes/android-dev-ext/issues).  
* This extension **will not build your app**. 
> You must use gradle or some other build procedure to create your APK. Once built, the extension can deploy and launch your app, allowing 
you to debug it in the normal way.  
* Some debugger options are yet to be implemented. You cannot modify local variable values or set conditional breakpoints and watch expressions must be simple variables.
* If you require a must-have feature that isn't there yet, let us know on [GitHub](https://github.com/adelphes/android-dev-ext/issues).  
* This extension does not provide any additional code completion or other editing enhancements.

## Extension Settings

This extension allows you to debug your App by creating a new Android configuration in `launch.json`.  
The following settings are used to configure the debugger:

    {
        "version": "0.2.0",
        "configurations": [
            {
                // configuration type, request  and name. "launch" is used to deploy the app to your device and start a debugging session
                "type": "android",
                "request": "launch",
                "name": "Launch App",

                // Location of the App source files. This value must point to the root of your App source tree (containing AndroidManifest.xml)
                "appSrcRoot": "${workspaceRoot}/app/src/main",

                // Fully qualified path to the built APK (Android Application Package)
                "apkFile": "${workspaceRoot}/app/build/outputs/apk/app-debug.apk",

                // Port number to connect to the local ADB (Android Debug Bridge) instance. Default: 5037
                "adbPort": 5037,

                // Launch behaviour if source files have been saved after the APK was built. One of: [ ignore warn stop ]. Default: warn
                "staleBuild": "warn",
            }
        ]
    }

## Questions / Problems

If you run into any problems, tell us on [GitHub](https://github.com/adelphes/android-dev-ext/issues) or contact me on [Twitter](https://twitter.com/daveholoway).
