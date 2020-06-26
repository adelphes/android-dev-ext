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

const { loadAndroidLibrary, JavaType, CEIType, ArrayType, PrimitiveType } = require('java-mti');

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
 * 
 * @param {string[]} uris
 */
function reparse(uris) {
    if (androidLibrary instanceof Promise) {
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
        parseMethodBodies(unit, typemap);
    });
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
        connection.console.log(`create parse ${version}`);
        liveParsers.set(uri, new JavaDocInfo(uri, content, version));
        reparse([uri]);
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
        reparse([document.uri]);
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
    liveParsers.delete(e.document.uri);
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
                    // fully-qualified type/field name
                    return getFullyQualifiedDottedIdentCompletion(parsed.typemap, options.loc.key.split(':').pop(), { statics: true });
                }
                if (/^fqs:/.test(options.loc.key)) {
                    // fully-qualified expression
                    return getTypedNameCompletion(parsed.typemap, options.loc.key.split(':').pop(),  { statics: true });
                }
                if (/^fqi:/.test(options.loc.key)) {
                    // fully-qualified expression
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
            ].sort(sortBy.label),
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
        item.documentation = documentation && {
            kind: 'markdown',
            value: `${header}\n\n${
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
