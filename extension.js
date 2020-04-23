// The module 'vscode' contains the VS Code extensibility API
// Import the module and reference it with the alias vscode in your code below
const vscode = require('vscode');
const { AndroidContentProvider } = require('./src/contentprovider');
const { openLogcatWindow } = require('./src/logcat');
const { selectAndroidProcessID } = require('./src/process-attach');
const { selectTargetDevice } = require('./src/utils/device');

// this method is called when your extension is activated
// your extension is activated the very first time the command is executed
function activate(context) {

    /* Only the logcat stuff is configured here. The debugger is launched from src/debugMain.js  */
    AndroidContentProvider.register(context, vscode.workspace);

    // The commandId parameter must match the command field in package.json
    const disposables = [
        // add the view logcat handler
        vscode.commands.registerCommand('android-dev-ext.view_logcat', () => {
            openLogcatWindow(vscode);
        }),
        // add the device picker handler - used to choose a target device
        vscode.commands.registerCommand('PickAndroidDevice', async () => {
            const device = await selectTargetDevice(vscode, "Launch", { alwaysShow:true });
            // the debugger requires a string value to be returned
            return JSON.stringify(device);
        }),
        // add the process picker handler - used to choose a PID to attach to
        vscode.commands.registerCommand('PickAndroidProcess', async () => {
            const o = await selectAndroidProcessID(vscode);
            // the debugger requires a string value to be returned
            return JSON.stringify(o);
        }),
    ];

    context.subscriptions.splice(context.subscriptions.length, 0, ...disposables);
}

// this method is called when your extension is deactivated
function deactivate() {
}

exports.activate = activate;
exports.deactivate = deactivate;
