const { JavaType, CEIType, ArrayType, PrimitiveType } = require('java-mti');
const { getTypeInheritanceList } = require('./java/expression-resolver');
const { CompletionItem, CompletionItemKind } = require('vscode-languageserver');
const { indexAt } = require('./document');
const { formatDoc } = require('./doc-formatter');
const { trace } = require('./logging');

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

/**
 * 
 * @param {import('vscode-languageserver').CompletionParams} params
 * @param {*} liveParsers 
 * @param {*} androidLibrary 
 */
async function getCompletionItems(params, liveParsers, androidLibrary) {
    // The pass parameter contains the position of the text document in
    // which code complete got requested. For the example we ignore this
    // info and always provide the same completion items.
    trace('getCompletionItems');
    if (androidLibrary instanceof Promise) {
        androidLibrary = await androidLibrary;
    }
    if (!params || !params.textDocument) {
        return [];
    }
    const docinfo = liveParsers.get(params.textDocument.uri);
    if (!docinfo || !docinfo.parsed) {
        return [];
    }
    const preversion = docinfo.version;
    await docinfo.reparseWaiter;
    if (docinfo.version !== preversion) {
        // if the content has changed, ignore the current request
        trace('content changed - ignoring completion items')
        /** @type {import('vscode-languageserver').CompletionList} */
        return {
            isIncomplete: true,
            items: [],
        }
    }
    let parsed = docinfo.parsed;

    lastCompletionTypeMap = (parsed && parsed.typemap) || androidLibrary;
    let locals = [], sourceTypes = [], show_instances = false;
    if (parsed.unit) {
        const index = indexAt(params.position, parsed.content);
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

/**
 * @param {CompletionItem} item
 */
function resolveCompletionItem(item) {
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
        detail = `${method.modifiers.filter(m => !/abstract|transient|native/.test(m)).join(' ')} ${t.simpleTypeName}.${method.name}`;
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

exports.getCompletionItems = getCompletionItems;
exports.resolveCompletionItem = resolveCompletionItem;
