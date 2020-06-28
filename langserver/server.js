const {
    createConnection,
    TextDocuments,
    ProposedFeatures,
    DidChangeConfigurationNotification,
    TextDocumentSyncKind,
} = require('vscode-languageserver');
const fs = require('fs');

const { TextDocument } = require('vscode-languageserver-textdocument');

const { loadAndroidSystemLibrary } = require('./java/java-libraries');
const { CEIType } = require('java-mti');

const { Settings } = require('./settings');
const { trace } = require('./logging');
const { getCompletionItems, resolveCompletionItem } = require('./completions');
const { getSignatureHelp } = require('./method-signatures');
const { getAppSourceRootFolder, JavaDocInfo, indexAt, reparse, rescanSourceFolders } = require('./document');

/**
 * The global map of Android system types
 * @typedef {Map<string, CEIType>} AndroidLibrary
 * @type {AndroidLibrary|Promise<AndroidLibrary>}
 */
let androidLibrary = null;

/**
 * The list of loaded Java documents
 * @type {Map<string,JavaDocInfo>}
 */
const liveParsers = new Map();

let hasConfigurationCapability = false;
let hasWorkspaceFolderCapability = false;

// Text document manager monitoring file opens and edits
let documents = new TextDocuments({
    /**
     *
     * @param {string} uri
     * @param {string} languageId
     * @param {number} version
     * @param {string} content
     */
    create(uri, languageId, version, content) {
        trace(`document create ${uri}:${version}`);

        // add the document to the set
        liveParsers.set(uri, new JavaDocInfo(uri, content, version));

        // tokenize the file content and build the initial parse state
        reparse([uri], liveParsers, androidLibrary, { includeMethods: true });

        return { uri };
    },
    /**
     *
     * @param {TextDocument} document
     * @param {import('vscode-languageserver').TextDocumentContentChangeEvent[]} changes
     * @param {number} version
     */
    update(document, changes, version) {
        trace(`document update ${document.uri}:${version}`);
        if (!liveParsers.has(document.uri)) {
            return;
        }
        const docinfo = liveParsers.get(document.uri);
        if (!docinfo) {
            return;
        }
        
        // apply the edits to our local content copy
        changes.forEach((change) => {
            /** @type {import('vscode-languageserver').Range} */
            const r = change['range'];
            if (r) {
                const start_index = indexAt(r.start, docinfo.content);
                let end_index = start_index + (r.end.character - r.start.character);
                if (r.end.line !== r.start.line) end_index = indexAt(r.end, docinfo.content);
                docinfo.content = `${docinfo.content.slice(0, start_index)}${change.text}${docinfo.content.slice(end_index)}`;
            }
        });

        docinfo.version = version;
        docinfo.scheduleReparse(liveParsers, androidLibrary);

        return document;
    },
});

// Create a connection for the server. The connection uses Node's IPC as a transport.
const connection = createConnection(ProposedFeatures.all);

connection.onInitialize((params) => {

    // the android library is loaded asynchronously, with the global `androidLibrary` variable
    // set to the promise while it is loading.
    androidLibrary = loadAndroidSystemLibrary((params.initializationOptions || {}).extensionPath)
        .then(
            library => androidLibrary = library,
            err => {
                console.log(`Android library load failed: ${err.message}\n Code completion may not be available.`);
                return new Map();
            }
        );

    let capabilities = params.capabilities;

    // Does the client support the `workspace/configuration` request?
    // If not, we will fall back using global settings
    hasConfigurationCapability = capabilities.workspace && !!capabilities.workspace.configuration;

    hasWorkspaceFolderCapability = capabilities.workspace && !!capabilities.workspace.workspaceFolders;

    return {
        capabilities: {
            // we support incremental updates
            textDocumentSync: TextDocumentSyncKind.Incremental,

            // we support code completion
            completionProvider: {
                resolveProvider: true,
            },

            // we support method signature information
            signatureHelpProvider : {
                triggerCharacters: [ '(' ]
            }
        },
    };
});

connection.onInitialized(async () => {
    if (hasConfigurationCapability) {
        // Register for all configuration changes.
        connection.client.register(
            DidChangeConfigurationNotification.type, {
                section: 'android-dev-ext',
        });
        const initialSettings = await connection.workspace.getConfiguration({
            section: "android-dev-ext"
        });
        Settings.set(initialSettings);
    }

    if (hasWorkspaceFolderCapability) {
        connection.workspace.onDidChangeWorkspaceFolders((_event) => {
            trace('Workspace folder change event received.');
        });
    }

    const src_folder = await getAppSourceRootFolder(connection.workspace);
    if (src_folder) {
        await rescanSourceFolders(src_folder, liveParsers);
        await new Promise(r=> setTimeout(r, 10000));
        console.log('first-parse');
        reparse([...liveParsers.keys()], liveParsers, androidLibrary, { includeMethods: false, first_parse: true });
    }

    trace('Initialization complete');
});

connection.onDidChangeConfiguration(async (change) => {
    trace(`onDidChangeConfiguration: ${JSON.stringify(change)}`);
    const old_app_root = Settings.appSourceRoot;

    // fetch and update the settings
    const newSettings = await connection.workspace.getConfiguration({
        section: "android-dev-ext"
    });

    Settings.set(newSettings);

    if (old_app_root !== Settings.appSourceRoot) {
        // if the app root has changed, rescan the source folder
        const src_folder = await getAppSourceRootFolder(connection.workspace);
        if (src_folder) {
            rescanSourceFolders(src_folder, liveParsers);
            reparse([...liveParsers.keys()], liveParsers, androidLibrary);
        }
    }
})

documents.onDidClose((e) => {
    trace(`doc closed ${e.document.uri}`);
    connection.sendDiagnostics({ uri: e.document.uri, diagnostics: [] });
});

connection.onDidChangeWatchedFiles(
    /** @param {import('vscode-languageserver').DidChangeWatchedFilesParams} params */
    (params) => {
        // Monitored files have change in VS Code
        trace(`watch file change: ${JSON.stringify(params)}`);
        let files_changed = false;
        params.changes.forEach(change => {
            switch(change.type) {
                case 1: // create
                    // if the user creates the file directly in vscode, the file will automatically open (and we receive an open callback)
                    // - but if the user creates or copies a file into the workspace, we need to manually add it to the set.
                    if (!liveParsers.has(change.uri) && /^file:\/\//.test(change.uri)) {
                        trace(`file added: ${change.uri}`)
                        try {
                            const fname = change.uri.replace(/^file:\/\//, '');
                            liveParsers.set(change.uri, new JavaDocInfo(change.uri, fs.readFileSync(fname, 'utf8'), 0));
                            files_changed = true;
                        } catch {}
                    }
                    break;
                case 2: // change
                    // called when the user manually saves the file - ignore for now
                    break;
                case 3: // delete
                    trace(`file deleted: ${change.uri}`)
                    liveParsers.delete(change.uri);
                    files_changed = true;
                    break;
            }
        });

        if (files_changed) {
            // reparse the entire set
            reparse([...liveParsers.keys()], liveParsers, androidLibrary);
        }
    }
);

// Retrieve the initial list of the completion items.
connection.onCompletion(params => getCompletionItems(params, liveParsers, androidLibrary));

// Resolve additional information for the item selected in the completion list.
connection.onCompletionResolve(item => resolveCompletionItem(item));

// Retrieve method signature information
connection.onSignatureHelp(params => getSignatureHelp(params, liveParsers));

// Make the text document manager listen on the connection
// for open, change and close text document events
documents.listen(connection);

// Listen on the connection
connection.listen();
