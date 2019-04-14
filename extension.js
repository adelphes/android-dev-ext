// The module 'vscode' contains the VS Code extensibility API
// Import the module and reference it with the alias vscode in your code below
const vscode = require('vscode');
const { AndroidContentProvider } = require('./src/contentprovider');
const { openLogcatWindow } = require('./src/logcat');

function getADBPort() {
    const defaultPort = 5037;
    const adbPort = AndroidContentProvider.getLaunchConfigSetting('adbPort', defaultPort);
    if (typeof adbPort === 'number' && adbPort === (adbPort|0)){
        return adbPort;
    }
    return defaultPort;
}

// this method is called when your extension is activated
// your extension is activated the very first time the command is executed
function activate(context) {

    /* Only the logcat stuff is configured here. The debugger is launched from src/debugMain.js  */
    AndroidContentProvider.register(context, vscode.workspace);

    // logcat connections require the (fake) websocket proxy to be up
    // - take the ADB port from launch.json
    const wsproxyserver = require('./src/wsproxy').proxy.Server(6037, getADBPort());

    // The commandId parameter must match the command field in package.json
    const disposables = [
        // add the view logcat handler
        vscode.commands.registerCommand('android-dev-ext.view_logcat', () => {
            openLogcatWindow(vscode);
        }),
        // watch for changes in the launch config
        vscode.workspace.onDidChangeConfiguration(() => {
            wsproxyserver.setADBPort(getADBPort());
        })
    ];

    context.subscriptions.splice(context.subscriptions.length, 0, ...disposables);
}

// this method is called when your extension is deactivated
function deactivate() {
}

exports.activate = activate;
exports.deactivate = deactivate;
