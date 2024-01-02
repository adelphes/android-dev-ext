const {
    createConnection,
    TextDocuments,
    ProposedFeatures,
    DidChangeConfigurationNotification,
    TextDocumentSyncKind,
} = require('vscode-languageserver');
const fs = require('fs');

const { URI } = require('vscode-uri');

const { loadAndroidSystemLibrary } = require('./java/java-libraries');

const { Settings } = require('./settings');
const { trace } = require('./logging');
const { clearDefaultCompletionEntries, getCompletionItems, resolveCompletionItem } = require('./completions');
const { getSignatureHelp } = require('./method-signatures');
const { FileURIMap, JavaDocInfo, indexAt, reparse } = require('./document');

const analytics = require('./analytics');
const package_json = require('./package.json');

/**
 * @typedef {import('vscode-languageserver-textdocument').TextDocument} TextDocument
 * @typedef {import('java-mti').CEIType} CEIType
 */

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
const liveParsers = new FileURIMap();

let startupOpts = null;
let hasConfigurationCapability = false;
let hasWorkspaceFolderCapability = false;

function loadCodeCompletionLibrary(extensionPath, codeCompletionLibraries) {
    // the android library is loaded asynchronously, with the global `androidLibrary` variable
    // set to the promise while it is loading.
    androidLibrary = (androidLibrary instanceof Promise
            ? androidLibrary    // if we're currently loading, wait for it to complete
            : Promise.resolve(new Map())
        )
        .then(() => loadAndroidSystemLibrary(extensionPath, codeCompletionLibraries))
        .then(
            library => androidLibrary = library,
            err => {
                console.log(`Android library load failed: ${err.message}\n Code completion may not be available.`);
                return new Map();
            }
        );
}

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

        // sanity-check - we only support Java source files
        if (!/\.java$/i.test(uri)) {
            return { uri };
        }

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

    startupOpts = {
        extensionPath: '',
        initialSettings: {
            appSourceRoot: '',
            /** @type {string[]} */
            codeCompletionLibraries: [],
            trace: false,
        },
        sourceFiles: [],
        ...params.initializationOptions,
    }

    Settings.set(startupOpts.initialSettings);
    analytics.init(undefined, startupOpts.uid, startupOpts.session_id, '', package_json, startupOpts.vscode_props, 'langserver-start');

    loadCodeCompletionLibrary(startupOpts.extensionPath, Settings.codeCompletionLibraries);

    let capabilities = params.capabilities;

    // Does the client support the `workspace/configuration` request?
    // If not, we will fall back using global settings
    hasConfigurationCapability = capabilities.workspace && !!capabilities.workspace.configuration;

    hasWorkspaceFolderCapability = capabilities.workspace && !!capabilities.workspace.workspaceFolders;

    /** @type {string[]} */
    const file_uris = Array.isArray(startupOpts.sourceFiles) ? startupOpts.sourceFiles : [];
    for (let file_uri of file_uris) {
        const file = URI.parse(file_uri, true);
        const filePath = file.fsPath;
        if (!/.java/i.test(filePath)) {
            trace(`ignoring non-java file: ${filePath}`);
            continue;
        }
        if (liveParsers.has(file_uri)) {
            trace(`File already loaded: ${file_uri}`);
            continue;
        }
        try {
            // it's fine to load the initial file set synchronously - the language server runs in a
            // separate process and nothing (useful) can happen until the first parse is complete.
            const content = fs.readFileSync(file.fsPath, 'utf8');
            liveParsers.set(file_uri, new JavaDocInfo(file_uri, content, 0));
            trace(`Added initial file: ${file_uri}`);
        } catch (err) {
            trace(`Failed to load initial source file: ${filePath}. ${err.message}`);
        }
    }
    reparse([...liveParsers.keys()], liveParsers, androidLibrary, { includeMethods: false, first_parse: true });

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
    }

    if (hasWorkspaceFolderCapability) {
        connection.workspace.onDidChangeWorkspaceFolders((_event) => {
            trace('Workspace folder change event received.');
        });
    }

    trace('Initialization complete');
});

connection.onDidChangeConfiguration(async (change) => {
    trace(`onDidChangeConfiguration: ${JSON.stringify(change)}`);

    const prev_ccl = [...new Set(Settings.codeCompletionLibraries)].sort();

    // fetch and update the settings
    const newSettings = await connection.workspace.getConfiguration({
        section: "android-dev-ext"
    });

    Settings.set(newSettings);

    if (Settings.updateCount > 2) {
        analytics.event('ls-settings-changed', {
            appSourceRoot: Settings.appSourceRoot,
            libs: Settings.codeCompletionLibraries,
            trace: Settings.trace,
        })
    }

    const new_ccl = [...new Set(Settings.codeCompletionLibraries)].sort();
    if (new_ccl.length !== prev_ccl.length || new_ccl.find((lib,idx) => lib !== prev_ccl[idx])) {
        // code-completion libraries have changed - reload the android library
        trace("code completion libraries changed - reloading android library and reparsing")
        loadCodeCompletionLibrary(startupOpts.extensionPath, Settings.codeCompletionLibraries);
        reparse([...liveParsers.keys()], liveParsers, androidLibrary, { includeMethods: false });
        clearDefaultCompletionEntries();
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
                    if (!liveParsers.has(change.uri)) {
                        trace(`file added: ${change.uri}`)
                        try {
                            const fname = URI.parse(change.uri, true).fsPath;
                            liveParsers.set(change.uri, new JavaDocInfo(change.uri, fs.readFileSync(fname, 'utf8'), 0));
                            files_changed = true;
                        } catch (err) {
                            console.log(`Failed to add new file '${change.uri}' to working set. ${err.message}`);
                        }
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
