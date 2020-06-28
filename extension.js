// The module 'vscode' contains the VS Code extensibility API
// Import the module and reference it with the alias vscode in your code below
const path = require('path');
const vscode = require('vscode');
const { LanguageClient, TransportKind, } = require('vscode-languageclient');
const { AndroidContentProvider } = require('./src/contentprovider');
const { openLogcatWindow } = require('./src/logcat');
const { selectAndroidProcessID } = require('./src/process-attach');
const { selectTargetDevice } = require('./src/utils/device');

/** @type {LanguageClient} */
let client;

/**
 * @param {vscode.ExtensionContext} context
 */
function activateLanguageClient(context) {
  // The server is implemented in node
  let serverModule = context.asAbsolutePath(path.join('langserver', 'server.js'));
  // The debug options for the server
  // --inspect=6009: runs the server in Node's Inspector mode so VS Code can attach to the server for debugging
  let debugOptions = { execArgv: ['--nolazy', '--inspect=6009'] };

  // If the extension is launched in debug mode then the debug server options are used
  // Otherwise the run options are used
  /** @type {import('vscode-languageclient').ServerOptions} */
  let serverOptions = {
    run: {
        module: serverModule,
        transport: TransportKind.ipc,
    },
    debug: {
      module: serverModule,
      transport: TransportKind.ipc,
      options: debugOptions
    }
  };

  // Options to control the language client
  /** @type {import('vscode-languageclient').LanguageClientOptions} */
  let clientOptions = {
    // Register the server for plain text documents
    documentSelector: [{ scheme: 'file', language: 'java' }],
    initializationOptions: {
        // extensionPath points to the root of the extension (the folder where this file is)
        extensionPath: context.extensionPath,
    },
    synchronize: {
      // Notify the server about file changes to '.java files contained in the workspace
      fileEvents: vscode.workspace.createFileSystemWatcher('**/.java')
    },
  };

  // Create the language client and start the client.
  client = new LanguageClient(
    'androidJavaLanguageServer',
    'Java (Android)',
    serverOptions,
    clientOptions
  );

  // Start the client. This will also launch the server
  return client.start();
}


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
        vscode.commands.registerCommand('PickAndroidDevice', async (launchConfig) => {
            // if the config has both PickAndroidDevice and PickAndroidProcess, ignore this
            // request as PickAndroidProcess already includes chooosing a device...
            if (launchConfig && launchConfig.processId === '${command:PickAndroidProcess}') {
                return '';
            }
            const device = await selectTargetDevice(vscode, "Launch", { alwaysShow:true });
            // the debugger requires a string value to be returned
            return JSON.stringify(device);
        }),
        // add the process picker handler - used to choose a PID to attach to
        vscode.commands.registerCommand('PickAndroidProcess', async (launchConfig) => {
            // if the config has a targetDevice specified, use it instead of choosing a device...
            let target_device = '';
            if (launchConfig && typeof launchConfig.targetDevice === 'string') {
                target_device = launchConfig.targetDevice;
            }
            const explicit_pick_device = target_device === '${command:PickAndroidDevice}';
            if (!target_device || explicit_pick_device) {
                // no targetDevice (or it's set to ${command:PickAndroidDevice})
                const device = await selectTargetDevice(vscode, 'Attach', { alwaysShow: explicit_pick_device });
                if (!device) {
                    return JSON.stringify({status: 'cancelled'});
                }
                target_device = device.serial;
            }
            const o = await selectAndroidProcessID(vscode, target_device);
            // the debugger requires a string value to be returned
            return JSON.stringify(o);
        }),

        activateLanguageClient(context),
    ];

    context.subscriptions.splice(context.subscriptions.length, 0, ...disposables);
}

// this method is called when your extension is deactivated
function deactivate() {
}

exports.activate = activate;
exports.deactivate = deactivate;
