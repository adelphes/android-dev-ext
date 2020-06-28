const fs = require('fs');
const path = require('path');
const os = require('os');
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

const { Settings } = require('./settings');
const { loadAndroidSystemLibrary } = require('./java/java-libraries');
const { JavaType, CEIType, ArrayType, PrimitiveType, Method } = require('java-mti');

const { ParseProblem } = require('./java/parser');
const { parse } = require('./java/body-parser3');
const { SourceUnit } = require('./java/source-types');
const { validate, parseMethodBodies } = require('./java/validater');
const { getTypeInheritanceList } = require('./java/expression-resolver');

/**
 * @typedef {Map<string, CEIType>} AndroidLibrary
 * @type {AndroidLibrary|Promise<AndroidLibrary>}
 */
let androidLibrary = null;

// Create a connection for the server. The connection uses Node's IPC as a transport.
// Also include all preview / proposed LSP features.
let connection = createConnection(ProposedFeatures.all);

/**
 * 
 * @param {{line:number,character:number}} pos 
 * @param {string} content 
 */
function indexAt(pos, content) {
    let idx = 0;
    for (let i = 0; i < pos.line; i++) {
        idx = content.indexOf('\n', idx) + 1;
        if (idx === 0) {
            return content.length;
        }
    }
    return Math.min(idx + pos.character, content.length);
}

/**
 * @param {number} index 
 * @param {string} content 
 */
function positionAt(index, content) {
    let line = 0,
        last_nl_idx = 0,
        character = 0;
    if (index <= 0) return { line, character };
    for (let idx = 0; ;) {
        idx = content.indexOf('\n', idx) + 1;
        if (idx === 0 || idx > index) {
            if (idx === 0) index = content.length;
            character = index - last_nl_idx;
            return { line, character };
        }
        last_nl_idx = idx;
        line++;
    }
}

/**
 * @param {string} s 
 */
function trace(s) {
    console.log(`${Date.now()}: ${s}`);
}

class JavaDocInfo {
     /**
      * @param {string} uri 
      * @param {string} content 
      * @param {number} version 
      */
     constructor(uri, content, version) {
         this.uri = uri;
         this.content = content;
         this.version = version;
         /** @type {ParsedInfo} */
         this.parsed = null;
         /** @type {Promise} */
         this.reparseWaiter = Promise.resolve();
         /** @type {{ resolve: () => void, timer: * }} */
         this.waitInfo = null;
     }

     /**
      * Schedule this document for reparsing.
      * 
      * To prevent redundant parsing while typing, a small delay is required 
      * before the reparse happens.
      * When a key is pressed, `scheduleReparse()` starts a timer. If more
      * keys are typed before the timer expires, the timer is restarted.
      * Once typing pauses, the timer expires and the content reparsed.
      * 
      * A `reparseWaiter` promise is used to delay the completion items
      * retrieval until the reparse is complete.
      */
     scheduleReparse() {
        const createWaitTimer = () => {
            return setTimeout(() => {
                // reparse the content, resolve the reparseWaiter promise
                // and reset the fields
                reparse([this.uri], { includeMethods: true });
                this.waitInfo.resolve();
                this.waitInfo = null;
            }, 250);
         }
         if (this.waitInfo) {
             // we already have a promise pending - just restart the timer
             trace('restart timer');
             clearTimeout(this.waitInfo.timer);
             this.waitInfo.timer = createWaitTimer();
             return;
         }
         // create a new pending promise and start the timer
         trace('start timer');
         this.waitInfo = {
            resolve: null,
            timer: createWaitTimer(),
        }
        this.reparseWaiter = new Promise(resolve => this.waitInfo.resolve = resolve);
    }
}

class ParsedInfo {
    /**
     * @param {string} uri 
     * @param {string} content 
     * @param {number} version 
     * @param {Map<string,CEIType>} typemap 
     * @param {SourceUnit} unit 
     * @param {ParseProblem[]} problems 
     */
    constructor(uri, content, version, typemap, unit, problems) {
        this.uri = uri;
        this.content = content;
        this.version = version;
        this.typemap = typemap;
        this.unit = unit;
        this.problems = problems;
    }
}

/** @type {Map<string,JavaDocInfo>} */
const liveParsers = new Map();

/**
 * Marker to prevent early parsing of source files before we've completed our
 * initial source file load
 * @type {Set<string>}
 */
let first_parse_waiting = new Set();

/**
 * @param {string[]} uris
 * @param {{includeMethods: boolean, first_parse?: boolean}} [opts]
 */
function reparse(uris, opts) {
    trace('reparse');
    if (!uris || !uris.length) {
        return;
    }
    if (first_parse_waiting) {
        if (!opts || !opts.first_parse) {
            uris.forEach(uri => first_parse_waiting.add(uri));
            trace('waiting for first parse')
            return;
        }
    }
    if (androidLibrary instanceof Promise) {
        // reparse after the library has loaded
        androidLibrary.then(() => reparse(uris, opts));
        return;
    }
    const cached_units = [], parsers = [];
    for (let docinfo of liveParsers.values()) {
        if (uris.includes(docinfo.uri)) {
            // make a copy of the content in case doc changes while we're parsing
            parsers.push({uri: docinfo.uri, content: docinfo.content, version: docinfo.version});
        } else if (docinfo.parsed) {
            cached_units.push(docinfo.parsed.unit);
        }
    }
    if (!parsers.length) {
        return;
    }

    const typemap = new Map(androidLibrary);
    const units = parse(parsers, cached_units, typemap);

    units.forEach(unit => {
        const parser = parsers.find(p => p.uri === unit.uri);
        if (!parser) return;
        const doc = liveParsers.get(unit.uri);
        if (!doc) return;
        doc.parsed = new ParsedInfo(doc.uri, parser.content, parser.version, typemap, unit, []);
    });

    let method_body_uris = [];
    if (first_parse_waiting) {
        // this is the first parse - parse the bodies of any waiting
        method_body_uris = [...first_parse_waiting];
        first_parse_waiting = null;
    }

    if (opts && opts.includeMethods) {
        method_body_uris = uris;
    }

    if (method_body_uris.length) {
        console.time('parse-methods');
        method_body_uris.forEach(uri => {
            const doc = liveParsers.get(uri);
            if (!doc || !doc.parsed) {
                return;
            }
            parseMethodBodies(doc.parsed.unit, typemap);
        })
        console.timeEnd('parse-methods');
    }
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
        // tokenize the file content and build the initial parse state
        trace(`create ${uri}:${version}`);
        liveParsers.set(uri, new JavaDocInfo(uri, content, version));
        reparse([uri], { includeMethods: true });
        return { uri };
    },
    /**
     *
     * @param {TextDocument} document
     * @param {import('vscode-languageserver').TextDocumentContentChangeEvent[]} changes
     * @param {number} version
     */
    update(document, changes, version) {
        trace(`update ${document.uri}:${version}`);
        if (!document || !liveParsers.has(document.uri)) {
            return;
        }
        const docinfo = liveParsers.get(document.uri);
        if (!docinfo) {
            return;
        }
        
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
        docinfo.scheduleReparse();

        return document;
    },
});

let hasConfigurationCapability = false;
let hasWorkspaceFolderCapability = false;
let hasDiagnosticRelatedInformationCapability = false;

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

    hasDiagnosticRelatedInformationCapability =
        capabilities.textDocument && capabilities.textDocument.publishDiagnostics && capabilities.textDocument.publishDiagnostics.relatedInformation;

    return {
        capabilities: {
            textDocumentSync: TextDocumentSyncKind.Incremental,
            // Tell the client that the server supports code completion
            completionProvider: {
                resolveProvider: true,
            },
            // Tell the client that the server supports method signature information
            signatureHelpProvider : {
                triggerCharacters: [ '(' ]
            }
        },
    };
});

connection.onInitialized(async () => {
    if (hasConfigurationCapability) {
        // Register for all configuration changes.
        connection.client.register(DidChangeConfigurationNotification.type, undefined);
        const initialSettings = await connection.workspace.getConfiguration({
            section: Settings.ID,
        });
        Settings.set(initialSettings);
    }

    if (hasWorkspaceFolderCapability) {
        connection.workspace.onDidChangeWorkspaceFolders((_event) => {
            trace('Workspace folder change event received.');
        });
    }

    const src_folder = await getAppRootFolder();
    if (src_folder) {
        await rescanSourceFolders(src_folder);
        reparse([...liveParsers.keys()], { includeMethods: false, first_parse: true });
    }

    trace('Initialization complete');
});

/**
 * Called during initialization and whenver the App Root setting is changed to scan
 * for source files
 * @param {string} src_folder absolute path to the source root
 */
async function rescanSourceFolders(src_folder) {
    if (!src_folder) {
        return;
    }

    // when the appRoot config value changes and we rescan the folder, we need
    // to delete any parsers that were from the old appRoot
    const unused_keys = new Set(liveParsers.keys());

    const files = await loadWorkingFileList(src_folder);

    // create live parsers for all the java files, but don't replace any existing ones which
    // have been loaded (and may be edited) before we reach here
    for (let file of files) {
        if (!/\.java$/i.test(file.fpn)) {
            continue;
        }
        const uri = `file://${file.fpn}`;    // todo - handle case-differences on Windows
        unused_keys.delete(uri);

        if (liveParsers.has(uri)) {
            trace(`already loaded: ${uri}`);
            continue;
        }

        try {
            const file_content = await new Promise((res, rej) => fs.readFile(file.fpn, 'UTF8', (err,data) => err ? rej(err) : res(data)));
            liveParsers.set(uri, new JavaDocInfo(uri, file_content, 0));
        } catch {}
    }

    // remove any parsers that are no longer part of the working set
    unused_keys.forEach(uri => liveParsers.delete(uri));
}

/**
 * Attempts to locate the app root folder using workspace folders and the appRoot setting
 * @returns Absolute path to app root folder or null
 */
async function getAppRootFolder() {
    /** @type {string} */
    let src_folder = null;

    const folders = await connection.workspace.getWorkspaceFolders();
    if (!folders || !folders.length) {
        trace('No workspace folders');
        return src_folder;
    }

    folders.find(folder => {
        const main_folder = path.join(folder.uri.replace(/^\w+:\/\//, ''), Settings.appRoot);
        try {
            if (fs.statSync(main_folder).isDirectory()) {
                src_folder = main_folder;
                return true;
            }
        } catch {}
    });

    if (!src_folder) {
        console.log([
            `Failed to find source root from workspace folders:`,
            ...folders.map(f => ` - ${f.uri}`),
            'Configure the Android App Root value in your workspace settings to point to your source folder containing AndroidManifest.xml',
        ].join(os.EOL));
    }

    return src_folder;
}

async function loadWorkingFileList(src_folder) {
    if (!src_folder) {
        return [];
    }

    trace(`Using src root folder: ${src_folder}. Searching for Android project source files...`);
    console.time('source file search')
    const files = scanSourceFiles(src_folder);
    console.timeEnd('source file search');

    if (!files.find(file => /^androidmanifest.xml$/i.test(file.relfpn))) {
        console.log(`Warning: No AndroidManifest.xml found in app root folder. Check the Android App Root value in your workspace settings.`)
    }

    return files;

    /**
     * @param {string} base_folder 
     * @returns {{fpn:string, relfpn: string, stat:fs.Stats}[]}
     */
    function scanSourceFiles(base_folder) {
        // strip any trailing slash
        base_folder = base_folder.replace(/[\\/]+$/, '');
        const done = new Set(), folders = [base_folder], files = [];
        const max_folders = 100;
        while (folders.length) {
            const folder = folders.shift();
            if (done.has(folder)) {
                continue;
            }
            done.add(folder);
            if (done.size > max_folders) {
                console.log(`Max folder limit reached - cancelling file search`);
                break;
            }
            try {
                trace(`scan source folder ${folder}`)
                fs.readdirSync(folder)
                    .forEach(name => {
                        const fpn = path.join(folder, name);
                        const stat = fs.statSync(fpn);
                        files.push({
                            fpn,
                            // relative path (without leading slash)
                            relfpn: fpn.slice(base_folder.length + 1),
                            stat,
                        });
                        if (stat.isDirectory()) {
                            folders.push(fpn)
                        }
                    });
            } catch (err) {
                trace(`Failed to scan source folder ${folder}: ${err.message}`)
            }
        }
        return files;
    }
}

connection.onDidChangeConfiguration(async (change) => {
    trace(`onDidChangeConfiguration`);
    if (change && change.settings && change.settings[Settings.ID]) {
        const old_app_root = Settings.appRoot;
        Settings.onChange(change.settings[Settings.ID]);
        if (old_app_root !== Settings.appRoot) {
            const src_folder = await getAppRootFolder();
            if (src_folder) {
                rescanSourceFolders(src_folder);
                reparse([...liveParsers.keys()]);
            }
        }
    }
})

documents.onDidClose((e) => {
    trace(`doc closed ${e.document.uri}`);
    connection.sendDiagnostics({ uri: e.document.uri, diagnostics: [] });
});

// The content of a text document has changed. This event is emitted
// when the text document first opened or when its content has changed.
documents.onDidChangeContent((change) => {
    trace('onDidChangeContent');
    validateTextDocument(change.document);
});

/**
 * @param {{uri}} textDocument
 */
async function validateTextDocument(textDocument) {
    if (androidLibrary instanceof Promise) {
        trace('Waiting for Android Library load');
        androidLibrary = await androidLibrary;
    }
    /** @type {ParseProblem[]} */
    let problems = [];
    const parsed = liveParsers.get(textDocument.uri);


    if (parsed) {
        try {
            //problems = [...parsed.result.problems, ...validate(parsed.result.unit, parsed.typemap)];
        } catch(err) {
            console.error(err);
        }
    }

    const diagnostics = problems
        .filter((p) => p)
        .map((p) => {
            const start = positionAt(p.startIdx, parsed.content);
            const end = positionAt(p.endIdx, parsed.content);
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

connection.onDidChangeWatchedFiles((_change) => {
    // Monitored files have change in VS Code
    trace('We received a file change event');
});

/**
 * @param {{name:string}} a 
 * @param {{name:string}} b 
 */
const sortBy = {
    label: (a,b) => a.label.localeCompare(b.label, undefined, {sensitivity: 'base'}),
    name: (a,b) => a.name.localeCompare(b.name, undefined, {sensitivity: 'base'}),
}

/**
 * @param {Map<string,CEIType>} typemap
 * @param {string} type_signature 
 * @param {{ statics: boolean }} opts 
 * @param {string[]} [typelist]
 */
function getTypedNameCompletion(typemap, type_signature, opts, typelist) {
    let type, types, subtype_search;
    const arr_match = type_signature.match(/^\[+/);
    if (arr_match) {
        // for arrays, just create a dummy type
        types = [
            type = new ArrayType(PrimitiveType.map.V, arr_match[0].length),
            typemap.get('java/lang/Object'),
        ];
    } else if (!/^L.+;/.test(type_signature)) {
        return [];
    } else {
        type = typemap.get(type_signature.slice(1,-1));
        if (!type) {
            return [];
        }
        if (!(type instanceof CEIType)) {
            return [];
        }
        types = getTypeInheritanceList(type);
        subtype_search = type.shortSignature + '$';
    }


    // add inner types, fields and methods
    class FirstSetMap extends Map {
        set(key, value) {
            return this.has(key) ? this : super.set(key, value);
        }
    }
    const fields = new FirstSetMap(), methods = new FirstSetMap();

    /**
     * @param {string[]} modifiers 
     * @param {JavaType} t 
     */
    function shouldInclude(modifiers, t) {
        if (opts.statics !== modifiers.includes('static')) return;
        if (modifiers.includes('abstract')) return;
        if (modifiers.includes('public')) return true;
        if (modifiers.includes('protected')) return true;
        if (modifiers.includes('private') && t === type) return true;
        // @ts-ignore
        return t.packageName === type.packageName;
    }

    types.forEach((t,idx) => {
        t.fields.sort(sortBy.name)
            .filter(f => shouldInclude(f.modifiers, t))
            .forEach(f => fields.set(f.name, {f, t, sortText: `${idx+100}${f.name}`}));
        t.methods.sort(sortBy.name)
            .filter(f => shouldInclude(f.modifiers, t))
            .forEach(m => methods.set(`${m.name}${m.methodSignature}`, {m, t, sortText: `${idx+100}${m.name}`}));
    });

    return [
        ...(typelist || [...typemap.keys()]).map(t => {
            if (!opts.statics) return;
            if (!subtype_search || !t.startsWith(subtype_search)) return;
            return {
                label: t.slice(subtype_search.length).replace(/\$/g,'.'),
                kind: CompletionItemKind.Class,
            }
        }).filter(x => x),
        // fields
        ...[...fields.values()].map(f => ({
            label: `${f.f.name}: ${f.f.type.simpleTypeName}`,
            insertText: f.f.name,
            kind: CompletionItemKind.Field,
            sortText: f.sortText,
            data: { type: f.t.shortSignature, fidx: f.t.fields.indexOf(f.f) },
        })),
        // methods
        ...[...methods.values()].map(m => ({
            label: m.m.shortlabel,
            kind: CompletionItemKind.Method,
            insertText: m.m.name,
            sortText: m.sortText,
            data: { type: m.t.shortSignature, midx: m.t.methods.indexOf(m.m) },
        }))
    ]
}
    
/**
 * @param {Map<string,CEIType>} typemap
 * @param {string} dotted_name 
 * @param {{ statics: boolean }} opts 
 */
function getFullyQualifiedDottedIdentCompletion(typemap, dotted_name, opts) {
    if (dotted_name === '') {
        return getPackageCompletion(typemap, '');
    }
    // name is a fully dotted name, possibly including members and their fields
    let typelist = [...typemap.keys()];

    const split_name = dotted_name.split('.');
    let pkgname = '';
    /** @type {JavaType} */
    let type = null, typename = '';
    for (let name_part of split_name) {
        if (type) {
            if (opts.statics && typelist.includes(`${typename}$${name_part}`)) {
                type = typemap.get(typename = `${typename}$${name_part}`);
                continue;
            }
            break;
        }
        typename = pkgname + name_part;
        if (typelist.includes(typename)) {
            type = typemap.get(typename);
            continue;
        }
        pkgname = `${pkgname}${name_part}/`;
    }

    if (type) {
        return getTypedNameCompletion(typemap, type.typeSignature, opts, typelist);
    }

    // sub-package or type
    const search_pkg = pkgname;
    return typelist.reduce((arr,typename) => {
        if (typename.startsWith(search_pkg)) {
            const m = typename.slice(search_pkg.length).match(/^(.+?)(\/|$)/);
            if (m) {
                if (m[2]) {
                    // package name
                    if (!arr.find(x => x.label === m[1])) {
                        arr.push({
                            label: m[1],
                            kind: CompletionItemKind.Unit,
                            data: -1,
                        })
                    }
                } else {
                    // type name
                    arr.push({
                        label: m[1].replace(/\$/g,'.'),
                        kind: CompletionItemKind.Class,
                        data: -1,
                    })
                }
            }
        }
        return arr;
    }, []);
}

/**
 * @param {Map<string,CEIType>} typemap
 */
function getRootPackageCompletions(typemap) {
    const pkgs = [...typemap.keys()].reduce((set,typename) => {
        const m = typename.match(/(.+?)\//);
        m && set.add(m[1]);
        return set;
    }, new Set());
    return [...pkgs].filter(x => x).sort().map(pkg => ({
        label: pkg,
        kind: CompletionItemKind.Unit,
        sortText: pkg,
    }));
}

/**
 * @param {Map<string,CEIType>} typemap
 * @param {string} pkg
 */
function getPackageCompletion(typemap, pkg) {
    if (pkg === '') {
        return getRootPackageCompletions(typemap);
    }
    // sub-package
    const search_pkg = pkg + '/';
    const pkgs = [...typemap.keys()].reduce((arr,typename) => {
        if (typename.startsWith(search_pkg)) {
            const m = typename.slice(search_pkg.length).match(/^(.+?)\//);
            if (m) arr.add(m[1]);
        }
        return arr;
    }, new Set());

    return [...pkgs].filter(x => x).sort().map(pkg => ({
        label: pkg,
        kind: CompletionItemKind.Unit,
        data: -1,
    }));
}

let defaultCompletionTypes = null;
/** @type {Map<string,CEIType>} */
let lastCompletionTypeMap = null;
const typeKindMap = {
    class: CompletionItemKind.Class,
    interface: CompletionItemKind.Interface,
    '@interface': CompletionItemKind.Interface,
    enum: CompletionItemKind.Enum,
};
function initDefaultCompletionTypes(lib) {
    defaultCompletionTypes = {
        instances: 'this super'.split(' ').map(t => ({
            label: t,
            kind: CompletionItemKind.Value,
            sortText: t
        })),
        // primitive types
        primitiveTypes:'boolean byte char double float int long short void'.split(' ').map((t) => ({
            label: t,
            kind: CompletionItemKind.Keyword,
            sortText: t,
        })),
        // modifiers
        modifiers: 'public private protected static final abstract volatile native transient strictfp synchronized'.split(' ').map((t) => ({
            label: t,
            kind: CompletionItemKind.Keyword,
            sortText: t,
        })),
        // literals
        literals: 'false true null'.split(' ').map((t) => ({
            label: t,
            kind: CompletionItemKind.Value,
            sortText: t
        })),
        // type names
        types: [...lib.values()].map(
            t =>
                /** @type {CompletionItem} */
                ({
                    label: t.dottedTypeName,
                    kind: typeKindMap[t.typeKind],
                    data: { type:t.shortSignature },
                    sortText: t.dottedTypeName,
                })
            ).sort((a,b) => a.label.localeCompare(b.label, undefined, {sensitivity:'base'})),

        // package names
        packageNames: getRootPackageCompletions(lib),
    }
}


// This handler provides the initial list of the completion items.
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
        const docinfo = liveParsers.get(_textDocumentPosition.textDocument.uri);
        if (!docinfo || !docinfo.parsed) {
            return [];
        }
        trace('reparse waiter - ' + docinfo.version);
        const preversion = docinfo.version;
        await docinfo.reparseWaiter;
        trace('retrieving completion items - ' + docinfo.version);
        if (docinfo.version !== preversion) {
            // if the content has changed, ignore the current request
            /** @type {import('vscode-languageserver').CompletionList} */
            return {
                isIncomplete: true,
                items: [],
            }
        }
        const parsed = docinfo.parsed;
        lastCompletionTypeMap = (parsed && parsed.typemap) || androidLibrary;
        let locals = [], sourceTypes = [], show_instances = false;
        if (parsed.unit) {
            const index = indexAt(_textDocumentPosition.position, parsed.content);
            const options = parsed.unit.getCompletionOptionsAt(index);
            if (options.loc) {
                if (/^pkgname:/.test(options.loc.key)) {
                    return getPackageCompletion(parsed.typemap, options.loc.key.split(':').pop());
                }
                if (/^fqdi:/.test(options.loc.key)) {
                    // fully-qualified dotted identifier
                    return getFullyQualifiedDottedIdentCompletion(parsed.typemap, options.loc.key.split(':').pop(), { statics: true });
                }
                if (/^fqs:/.test(options.loc.key)) {
                    // fully-qualified static expression
                    return getTypedNameCompletion(parsed.typemap, options.loc.key.split(':').pop(),  { statics: true });
                }
                if (/^fqi:/.test(options.loc.key)) {
                    // fully-qualified instance expression
                    return getTypedNameCompletion(parsed.typemap, options.loc.key.split(':').pop(),  { statics: false });
                }
            }
            if (options.method) {
                show_instances = !options.method.modifiers.includes('static');
                locals = options.method.parameters.sort(sortBy.name).map(p => ({
                    label: p.name,
                    kind: CompletionItemKind.Variable,
                    sortText: p.name,
                }))
            }
        }

        if (!defaultCompletionTypes) {
            initDefaultCompletionTypes(androidLibrary);
        }

        liveParsers.forEach(doc => {
            if (!doc.parsed) {
                return;
            }
            doc.parsed.unit.types.forEach(
                t => sourceTypes.push({
                    label: t.dottedTypeName,
                    kind: typeKindMap[t.typeKind],
                    data: { type:t.shortSignature },
                    sortText: t.dottedTypeName,
                })
            )
        });
    
        return [
            ...locals,
            ...(show_instances ? defaultCompletionTypes.instances : []),
            ...defaultCompletionTypes.primitiveTypes,
            ...defaultCompletionTypes.literals,
            ...defaultCompletionTypes.modifiers,
            ...[
                ...defaultCompletionTypes.types,
                ...sourceTypes,
            ]   // exclude dotted (inner) types because they result in useless 
                // matches in the intellisense filter when . is pressed
                .filter(x => !x.label.includes('.'))
                .sort(sortBy.label),
            ...defaultCompletionTypes.packageNames,
        ].map((x,idx) => {
            x.sortText = `${10000+idx}-${x.label}`;
            return x;
        })
    }
);

// This handler resolves additional information for the item selected in
// the completion list.
connection.onCompletionResolve(
    /**
     * @param {CompletionItem} item
     */
    (item) => {
        item.detail = item.documentation = '';
        if (!lastCompletionTypeMap) {
            return item;
        }
        if (typeof item.data !== 'object') {
            return item;
        }
        const t = lastCompletionTypeMap.get(item.data.type);
        const field = t && t.fields[item.data.fidx];
        const method = t && t.methods[item.data.midx];
        if (!t) {
            return item;
        }
        let detail, documentation, header;
        if (field) {
            detail = field.label;
            documentation = field.docs;
            header = `${field.type.simpleTypeName} **${field.name}**`;
        } else if (method) {
            detail = `${method.modifiers.join(' ')} ${t.simpleTypeName}.${method.name}`;
            documentation = method.docs;
            header = method.shortlabel.replace(/^\w+/, x => `**${x}**`).replace(/^(.+?)\s*:\s*(.+)/, (_,a,b) => `${b} ${a}`);
        } else {
            detail = t.fullyDottedRawName,
            documentation = t.docs,
            header = `${t.typeKind} **${t.dottedTypeName}**`;
        }
        item.detail = detail || '';
        item.documentation = formatDoc(header, documentation);
        return item;
    }
);

/**
 * @param {string} header 
 * @param {string} documentation 
 * @returns {import('vscode-languageserver').MarkupContent}
 */
function formatDoc(header, documentation) {
    if (!documentation) {
        return null;
    }
    return {
        kind: 'markdown',
        value: `${header ? header + '\n\n' : ''}${
            documentation
            .replace(/(^\/\*+|(?<=\n)[ \t]*\*+\/?|\*+\/)/gm, '')
            .replace(/(\n[ \t]*@[a-z]+)|(<p(?: .*)?>)|(<\/?i>|<\/?em>)|(<\/?b>|<\/?strong>|<\/?dt>)|(<\/?tt>)|(<\/?code>|<\/?pre>|<\/?blockquote>)|(\{@link.+?\}|\{@code.+?\})|(<li>)|(<a href="\{@docRoot\}.*?">.+?<\/a>)|(<h\d>)|<\/?dd ?.*?>|<\/p ?.*?>|<\/h\d ?.*?>|<\/?div ?.*?>|<\/?[uo]l ?.*?>/gim, (_,prm,p,i,b,tt,c,lc,li,a,h) => {
                return prm ? `  ${prm}`
                : p ? '\n\n'
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
}

/**
 * @param {import('vscode-languageserver').SignatureHelpParams} request the reeust
 */
async function onSignatureHelp(request) {
    trace('onSignatureHelp');
    /** @type {import('vscode-languageserver').SignatureHelp} */
    let sighelp = {
        signatures: [],
        activeSignature: 0,
        activeParameter: 0,
    }
    const docinfo = liveParsers.get(request.textDocument.uri);
    if (!docinfo || !docinfo.parsed) {
        return sighelp;
    }
    await docinfo.reparseWaiter;
    const index = indexAt(request.position, docinfo.content);
    const token = docinfo.parsed.unit.getTokenAt(index);
    if (!token || !token.methodCallInfo) {
        trace('onSignatureHelp - no method call info');
        return sighelp;
    }
    trace(`onSignatureHelp - ${token.methodCallInfo.methods.length} methods`);
    sighelp = {
        signatures: token.methodCallInfo.methods.map(m => {
            const documentation = formatDoc(`#### ${m.owner.simpleTypeName}${m instanceof Method ? `.${m.name}` : ''}()`, m.docs);
            const param_docs = new Map();
            if (documentation) {
                for (let m, re=/@param\s+(\S+)([\d\D]+?)(?=\n\n|\n[ \t*]*@\w+|$)/g; m = re.exec(documentation.value);) {
                    param_docs.set(m[1], m[2]);
                }
            }
            /** @type {import('vscode-languageserver').SignatureInformation} */
            let si = {
                label: m.label,
                documentation,
                parameters: m.parameters.map(p => {
                    /** @type {import('vscode-languageserver').ParameterInformation} */
                    let pi = {
                        documentation: {
                            kind: 'markdown',
                            value: param_docs.has(p.name) ? `**${p.name}**: ${param_docs.get(p.name)}` : '',
                        },
                        label: p.label
                    }
                    return pi;
                })
            }
            return si;
        }),
        activeSignature: token.methodCallInfo.methodIdx,
        activeParameter: token.methodCallInfo.argIdx,
    }
    return sighelp;
    
}
connection.onSignatureHelp(onSignatureHelp);

/*
    connection.onDidOpenTextDocument((params) => {
        // A text document got opened in VS Code.
        // params.uri uniquely identifies the document. For documents store on disk this is a file URI.
        // params.text the initial full content of the document.
        trace(`${params.textDocument.uri} opened.`);
    });
    connection.onDidChangeTextDocument((params) => {
        // The content of a text document did change in VS Code.
        // params.uri uniquely identifies the document.
        // params.contentChanges describe the content changes to the document.
        trace(`${params.textDocument.uri} changed: ${JSON.stringify(params.contentChanges)}`);
    });
    connection.onDidCloseTextDocument((params) => {
        // A text document got closed in VS Code.
        // params.uri uniquely identifies the document.
        trace(`${params.textDocument.uri} closed.`);
    });
    */

// Make the text document manager listen on the connection
// for open, change and close text document events
documents.listen(connection);

// Listen on the connection
connection.listen();
