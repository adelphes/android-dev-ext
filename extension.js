// The module 'vscode' contains the VS Code extensibility API
// Import the module and reference it with the alias vscode in your code below
const vscode = require('vscode');
const { AndroidContentProvider, openLogcatWindow } = require('./src/logcat');

function getADBPort() {
    var adbPort = 5037;
    // there's surely got to be a better way than this...
    var configs = vscode.workspace.getConfiguration('launch.configurations');
    for (var i=0,config; config=configs.get(''+i); i++) {
        if (config.type!=='android') continue;
        if (config.request!=='launch') continue;
        if (typeof config.adbPort === 'number' && config.adbPort === (config.adbPort|0))
            adbPort = config.adbPort;
        break;
    }
    return adbPort;
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
    var disposables = [
        // add the view logcat handler
        vscode.commands.registerCommand('android-dev-ext.view_logcat', () => {
            openLogcatWindow(vscode);
        }),
        // watch for changes in the launch config
        vscode.workspace.onDidChangeConfiguration(e => {
            wsproxyserver.setADBPort(getADBPort());
        })
    ];

    var spliceparams = [context.subscriptions.length,0].concat(disposables);
    Array.prototype.splice.apply(context.subscriptions,spliceparams);
}
exports.activate = activate;

// this method is called when your extension is deactivated
function deactivate() {
}
exports.deactivate = deactivate;