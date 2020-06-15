const fs = require('fs');
const {
    createConnection,
    TextDocuments,
    //TextDocument,
    Diagnostic,
    DiagnosticSeverity,
    ProposedFeatures,
    //InitializeParams,
    DidChangeConfigurationNotification,
    CompletionItem,
    CompletionItemKind,
    TextDocumentSyncKind,
    Position,
    //TextDocumentPositionParams
} = require('vscode-languageserver');

const { TextDocument } = require('vscode-languageserver-textdocument');

const { loadAndroidLibrary, JavaType } = require('java-mti');

const { ParseProblem } = require('./java/parser');
const { parse } = require('./java/body-parser3');
const { SourceUnit } = require('./java/source-type');
const { validate } = require('./java/validater');

/**
 * @typedef {Map<string, JavaType>} AndroidLibrary
 * @type {AndroidLibrary|Promise<AndroidLibrary>}
 */
let androidLibrary = null;

// Create a connection for the server. The connection uses Node's IPC as a transport.
// Also include all preview / proposed LSP features.
let connection = createConnection(ProposedFeatures.all);

/**
 * @typedef LiveParseInfo
 * @property {string} uri
 * @property {JavaTokenizer.LineInfo[]} lines
 * @property {{startState: string, states: string[], endState: string}[]} states
 */

///** @type {LiveParseInfo[]} */
//const liveParsers = [];
/** @type {{content: string, uri: string, result: {unit:SourceUnit, problems:*[]}, typemap:Map<string,JavaType>, positionAt:(n) => Position, indexAt:(p:Position) => number}} */
let parsed = null;

function reparse(uri, content) {
    if (androidLibrary instanceof Promise) {
        return;
    }
    const typemap = new Map(androidLibrary);
    const result = parse(content, typemap);
    parsed = {
        content,
        uri,
        result,
        typemap,
        positionAt(n) {
            let line = 0,
                last_nl_idx = 0,
                character = 0;
            if (n <= 0) return { line, character };
            for (let idx = 0; ;) {
                idx = this.content.indexOf('\n', idx) + 1;
                if (idx === 0 || idx > n) {
                    if (idx === 0) n = content.length;
                    character = n - last_nl_idx;
                    return { line, character };
                }
                last_nl_idx = idx;
                line++;
            }
        },
        indexAt(pos) {
            let idx = 0;
            for (let i = 0; i < pos.line; i++) {
                idx = this.content.indexOf('\n', idx) + 1;
                if (idx === 0) {
                    return this.content.length;
                }
            }
            return Math.min(idx + pos.character, this.content.length);
        },
    };
}

// Create a simple text document manager. The text document manager
// supports full document sync only
let documents = new TextDocuments({
    /**
     *
     * @param {string} uri
     * @param {string} languageId
     * @param {number} version
     * @param {string} content
     */
    create(uri, languageId, version, content) {
        //connection.console.log(JSON.stringify({what:'create',uri,languageId,version,content}));
        // tokenize the file content and build the initial parse state
        connection.console.log(`create parse ${version}`);
        reparse(uri, content);
        //connection.console.log(res.imports.length.toString());
        // const lines = JavaTokenizer.get().tokenizeSource(content);
        // const initialParse = new JavaParser().parseLines(lines);

        // liveParsers.push({
        //   uri,
        //   lines,
        //   states: initialParse,
        // })
        // console.log(initialParse.map(x => x.decls).filter(x => x.length).map(x => JSON.stringify(x, null, '  ')));

        return { uri };
    },
    /**
     *
     * @param {TextDocument} document
     * @param {import('vscode-languageserver').TextDocumentContentChangeEvent[]} changes
     * @param {number} version
     */
    update(document, changes, version) {
        connection.console.log(JSON.stringify({ what: 'update', /* changes, */ version }));
        //connection.console.log(`update ${version}`);
        //return document;
        if (parsed && document && parsed.uri === document.uri) {
            changes.forEach((change) => {
                /** @type {import('vscode-languageserver').Range} */
                const r = change['range'];
                if (r) {
                    const start_index = parsed.indexAt(r.start);
                    let end_index = start_index + (r.end.character - r.start.character);
                    if (r.end.line !== r.start.line) end_index = parsed.indexAt(r.end);
                    parsed.content = `${parsed.content.slice(0, start_index)}${change.text}${parsed.content.slice(end_index)}`;
                }
            });
            //connection.console.log(JSON.stringify(parsed.content));
            reparse(document.uri, parsed.content);
        }
        return document;
    },
});

let hasConfigurationCapability = false;
let hasWorkspaceFolderCapability = false;
let hasDiagnosticRelatedInformationCapability = false;

connection.onInitialize((params) => {
    console.time('android-library-load')
    androidLibrary = loadAndroidLibrary('android-25').then(lib => {
        console.timeEnd('android-library-load')
        return androidLibrary = lib;
    }, err => {
        console.log(`android library load failed: ${err.message}`);
        return androidLibrary = new Map();
    });
    let capabilities = params.capabilities;

    // Does the client support the `workspace/configuration` request?
    // If not, we will fall back using global settings
    hasConfigurationCapability = capabilities.workspace && !!capabilities.workspace.configuration;

    hasWorkspaceFolderCapability = capabilities.workspace && !!capabilities.workspace.workspaceFolders;

    hasDiagnosticRelatedInformationCapability =
        capabilities.textDocument && capabilities.textDocument.publishDiagnostics && capabilities.textDocument.publishDiagnostics.relatedInformation;

    return {
        capabilities: {
            textDocumentSync: TextDocumentSyncKind.Incremental,
            // Tell the client that the server supports code completion
            completionProvider: {
                resolveProvider: true,
            },
        },
    };
});

connection.onInitialized(() => {
    if (hasConfigurationCapability) {
        // Register for all configuration changes.
        connection.client.register(DidChangeConfigurationNotification.type, undefined);
    }
    if (hasWorkspaceFolderCapability) {
        connection.workspace.onDidChangeWorkspaceFolders((_event) => {
            connection.console.log('Workspace folder change event received.');
        });
    }
});

// The example settings
/**
 * @typedef ExampleSettings
 * @property {number} maxNumberOfProblems
 */

// The global settings, used when the `workspace/configuration` request is not supported by the client.
// Please note that this is not the case when using this server with the client provided in this example
// but could happen with other clients.
const defaultSettings = { maxNumberOfProblems: 1000 };
let globalSettings = defaultSettings;

// Cache the settings of all open documents
/** @type {Map<string, Thenable<ExampleSettings>>} */
let documentSettings = new Map();

connection.onDidChangeConfiguration((change) => {
    if (hasConfigurationCapability) {
        // Reset all cached document settings
        documentSettings.clear();
    } else {
        globalSettings = change.settings.androidJavaLanguageServer || defaultSettings;
    }

    // Revalidate all open text documents
    documents.all().forEach(validateTextDocument);
});

function getDocumentSettings(resource) {
    if (!hasConfigurationCapability) {
        return Promise.resolve(globalSettings);
    }
    let result = documentSettings.get(resource);
    if (!result) {
        result = connection.workspace.getConfiguration({
            scopeUri: resource,
            section: 'androidJavaLanguageServer',
        });
        documentSettings.set(resource, result);
    }
    return result;
}

// Only keep settings for open documents
documents.onDidClose((e) => {
    connection.console.log(`doc closed ${e.document.uri}`);
    parsed = null;
    documentSettings.delete(e.document.uri);
    connection.sendDiagnostics({ uri: e.document.uri, diagnostics: [] });
});

// The content of a text document has changed. This event is emitted
// when the text document first opened or when its content has changed.
documents.onDidChangeContent((change) => {
    connection.console.log(JSON.stringify(change));
    validateTextDocument(change.document);
});

/**
 * @param {{uri}} textDocument
 */
async function validateTextDocument(textDocument) {
    if (androidLibrary instanceof Promise) {
        connection.console.log('Waiting for Android Library load');
        androidLibrary = await androidLibrary;
    }
    /** @type {ParseProblem[]} */
    let problems = [];
    connection.console.log('validateTextDocument');

    if (parsed && parsed.result) {
        try {
            problems = [...parsed.result.problems, ...validate(parsed.result.unit, parsed.typemap)];
        } catch(err) {
            console.error(err);
        }
    }

    const diagnostics = problems
        .filter((p) => p)
        .map((p) => {
            const start = parsed.positionAt(p.startIdx);
            const end = parsed.positionAt(p.endIdx);
            /** @type {Diagnostic} */
            let diagnostic = {
                severity: p.severity,
                range: {
                    start,
                    end,
                },
                message: p.message,
                source: 'java-android',
            };
            return diagnostic;
        });
    connection.sendDiagnostics({ uri: textDocument.uri, diagnostics });
}

async function validateTextDocument2(textDocument) {
    // In this simple example we get the settings for every validate run.
    //let settings = await getDocumentSettings(textDocument.uri);

    // The validator creates diagnostics for all uppercase words length 2 and more
    let text = textDocument.getText();
    let pattern = /\b[A-Z]{2,}\b/g;
    let m;

    let problems = 0;
    let diagnostics = [];
    while ((m = pattern.exec(text)) /* && problems < settings.maxNumberOfProblems */) {
        problems++;
        /** @type {Diagnostic} */
        let diagnostic = {
            severity: DiagnosticSeverity.Warning,
            range: {
                start: textDocument.positionAt(m.index),
                end: textDocument.positionAt(m.index + m[0].length),
            },
            message: `${m[0]} is all uppercase.`,
            source: 'ex',
        };
        if (hasDiagnosticRelatedInformationCapability) {
            diagnostic.relatedInformation = [
                {
                    location: {
                        uri: textDocument.uri,
                        range: Object.assign({}, diagnostic.range),
                    },
                    message: 'Spelling matters',
                },
                {
                    location: {
                        uri: textDocument.uri,
                        range: Object.assign({}, diagnostic.range),
                    },
                    message: 'Particularly for names',
                },
            ];
        }
        diagnostics.push(diagnostic);
    }

    // Send the computed diagnostics to VS Code.
    connection.sendDiagnostics({ uri: textDocument.uri, diagnostics });
}

connection.onDidChangeWatchedFiles((_change) => {
    // Monitored files have change in VS Code
    connection.console.log('We received a file change event');
});

// This handler provides the initial list of the completion items.
let allCompletionTypes = null;
connection.onCompletion(
    /**
     * @param {*} _textDocumentPosition TextDocumentPositionParams
     */
    async (_textDocumentPosition) => {
        // The pass parameter contains the position of the text document in
        // which code complete got requested. For the example we ignore this
        // info and always provide the same completion items.
        if (androidLibrary instanceof Promise) {
            androidLibrary = await androidLibrary;
        }
        const lib = (parsed && parsed.typemap) || androidLibrary;
        if (!lib) return [];
        const typeKindMap = {
            class: CompletionItemKind.Class,
            interface: CompletionItemKind.Interface,
            '@interface': CompletionItemKind.Interface,
            enum: CompletionItemKind.Enum,
        };
        return (
            allCompletionTypes ||
            (allCompletionTypes = [
                ...'boolean byte char double float int long short void'.split(' ').map((t) => ({
                    label: t,
                    kind: CompletionItemKind.Keyword,
                    data: -1,
                })),
                ...'public private protected static final abstract volatile native transient strictfp'.split(' ').map((t) => ({
                    label: t,
                    kind: CompletionItemKind.Keyword,
                    data: -1,
                })),
                ...'false true null this super'.split(' ').map((t) => ({
                    label: t,
                    kind: CompletionItemKind.Value,
                    data: -1,
                })),
                ...[...lib.values()].map(
                    (t, idx) =>
                        /** @type {CompletionItem} */
                        ({
                            label: t.dottedTypeName,
                            kind: typeKindMap[t.typeKind],
                            data: t.shortSignature,
                        })
                ),
            ])
        );
    }
);

// This handler resolves additional information for the item selected in
// the completion list.
connection.onCompletionResolve(
    /**
     * @param {CompletionItem} item
     */
    (item) => {
        if (androidLibrary instanceof Promise) {
            return item;
        }
        const t = androidLibrary.get(item.data);
        if (!t) {
            return item;
        }
        item.detail = t.fullyDottedRawName;
        item.documentation = t.docs && {
            kind: 'markdown',
            value: `${t.typeKind} **${t.dottedTypeName}**\n\n${
                t.docs
                .replace(/(<p ?.*?>)|(<\/?i>|<\/?em>)|(<\/?b>|<\/?strong>|<\/?dt>)|(<\/?tt>)|(<\/?code>|<\/?pre>)|(\{@link.+?\}|\{@code.+?\})|(<li>)|(<a href="\{@docRoot\}.*?">.+?<\/a>)|(<h\d>)|<\/?dd ?.*?>|<\/p ?.*?>|<\/h\d ?.*?>|<\/?div ?.*?>|<\/?[uo]l ?.*?>/gim, (_,p,i,b,tt,c,lc,li,a,h) => {
                    return p ? '\n\n' 
                    : i ? '*' 
                    : b ? '**' 
                    : tt ? '`'
                    : c ? '\n```'
                    : lc ? lc.replace(/\{@\w+\s*(.+)\}/, (_,x) => `\`${x.trim()}\``)
                    : li ? '\n- '
                    : a ? a.replace(/.+?\{@docRoot\}(.*?)">(.+?)<\/a>/m, (_,p,t) => `[${t}](https://developer.android.com/${p})`)
                    : h ? `\n${'#'.repeat(1 + parseInt(h.slice(2,-1),10))} `
                    : '';
                })
            }`,
        };
        return item;
    }
);

/*
    connection.onDidOpenTextDocument((params) => {
        // A text document got opened in VS Code.
        // params.uri uniquely identifies the document. For documents store on disk this is a file URI.
        // params.text the initial full content of the document.
        connection.console.log(`${params.textDocument.uri} opened.`);
    });
    connection.onDidChangeTextDocument((params) => {
        // The content of a text document did change in VS Code.
        // params.uri uniquely identifies the document.
        // params.contentChanges describe the content changes to the document.
        connection.console.log(`${params.textDocument.uri} changed: ${JSON.stringify(params.contentChanges)}`);
    });
    connection.onDidCloseTextDocument((params) => {
        // A text document got closed in VS Code.
        // params.uri uniquely identifies the document.
        connection.console.log(`${params.textDocument.uri} closed.`);
    });
    */

// Make the text document manager listen on the connection
// for open, change and close text document events
documents.listen(connection);

// Listen on the connection
connection.listen();
