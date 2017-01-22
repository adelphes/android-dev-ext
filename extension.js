// The module 'vscode' contains the VS Code extensibility API
// Import the module and reference it with the alias vscode in your code below
var vscode = require('vscode');

// this method is called when your extension is activated
// your extension is activated the very first time the command is executed
function activate(context) {

    /* Nothing is done here. The debugger is launched from src/debugMain.js  */

    // The commandId parameter must match the command field in package.json
    var disposables = [
        /*
        vscode.commands.registerCommand('extension.doCommand', config => {
            return vscode.window.showInputBox({
                placeHolder: "Enter a value",
                value: "a value to display"
            });
        })
        */
    ];

    var spliceparams = [context.subscriptions.length,0].concat(disposables);
    Array.prototype.splice.apply(context.subscriptions,spliceparams);
}
exports.activate = activate;

// this method is called when your extension is deactivated
function deactivate() {
}
exports.deactivate = deactivate;