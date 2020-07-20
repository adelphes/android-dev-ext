const { JavaType, CEIType, ArrayType, PrimitiveType } = require('java-mti');
const { getTypeInheritanceList } = require('./java/expression-resolver');
const { CompletionItem, CompletionItemKind } = require('vscode-languageserver');
const { SourceType } = require('./java/source-types');
const { indexAt } = require('./document');
const { formatDoc } = require('./doc-formatter');
const { trace } = require('./logging');
const { event } = require('./analytics');

/**
 * Case-insensitive sort routines
 */
const sortBy = {
    label: (a,b) => a.label.localeCompare(b.label, undefined, {sensitivity: 'base'}),
    name: (a,b) => a.name.localeCompare(b.name, undefined, {sensitivity: 'base'}),
}

/** Map Java typeKind values to vscode CompletionItemKinds */
const TypeKindMap = {
    class: CompletionItemKind.Class,
    interface: CompletionItemKind.Interface,
    '@interface': CompletionItemKind.Interface,
    enum: CompletionItemKind.Enum,
};

/**
 * Return a list of vscode-compatible completion items for a given type.
 * 
 * The type is located in typemap and the members (fields, methods) are retrieved
 * and converted to completions items.
 * 
 * @param {Map<string,CEIType>} typemap Set of known types
 * @param {string} type_signature Type to provide completion items for
 * @param {{ statics: boolean }} opts used to control if static or instance members should be included
 * @param {string[]} [typelist] optional pre-prepared type list (to save recomputing it)
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
        // retrieve the complete list of inherited types
        types = getTypeInheritanceList(type);
        subtype_search = type.shortSignature + '$';
    }


    class SetOnceMap extends Map {
        set(key, value) {
            return this.has(key) ? this : super.set(key, value);
        }
    }
    const fields = new SetOnceMap(),
      methods = new SetOnceMap(),
      inner_types = new SetOnceMap(),
      enumValues = new SetOnceMap();

    /**
     * @param {string[]} modifiers 
     * @param {JavaType} t 
     * @param {boolean} [synthetic]
     */
    function shouldInclude(modifiers, t, synthetic) {
        // filter statics/instances
        if (opts.statics !== modifiers.includes('static')) return;
        // exclude synthetic entries
        if (synthetic) return;
        if (modifiers.includes('public')) return true;
        if (modifiers.includes('protected')) return true;
        // only include private items for the current type
        if (modifiers.includes('private') && t === type) return true;
        // @ts-ignore
        return t.packageName === type.packageName;
    }

    // retrieve fields and methods
    types.forEach(t => {
        if (t instanceof SourceType && opts.statics) {
            t.enumValues.sort(sortBy.name)
                .forEach(e => enumValues.set(e.name, {e, t}))
        }
        t.fields.sort(sortBy.name)
            .filter(f => shouldInclude(f.modifiers, t, f.isSynthetic))
            .forEach(f => {
                if (f.isEnumValue) {
                    enumValues.set(f.name, {e:f, t});
                } else {
                    fields.set(f.name, {f, t});
                }
            });
        t.methods.sort(sortBy.name)
            .filter(m => shouldInclude(m.modifiers, t, m.isSynthetic))
            .forEach(m => methods.set(`${m.name}${m.methodSignature}`, {m, t}));
    });

    if (opts.statics && subtype_search) {
        // retrieve inner types
        (typelist || [...typemap.keys()])
            .filter(type_signature =>
                type_signature.startsWith(subtype_search)
                        // ignore inner-inner types
                    && !type_signature.slice(subtype_search.length).includes('$')
            )
            .map(type_signature => typemap.get(type_signature))
            .forEach((t,idx) => inner_types.set(t.simpleTypeName, { t }));
    }

    return [
        // enum values
        ...[...enumValues.values()].map((e,idx) => ({
            label: `${e.e.name}: ${e.t.simpleTypeName}`,
            insertText: e.e.name,
            kind: CompletionItemKind.EnumMember,
            sortText: `${idx+1000}${e.e.name}`,
            data: { type: e.t.shortSignature, fidx: e.t.fields.indexOf(e.e) },
        })),
        // fields
        ...[...fields.values()].map((f,idx) => ({
            label: `${f.f.name}: ${f.f.type.simpleTypeName}`,
            insertText: f.f.name,
            kind: CompletionItemKind.Field,
            sortText: `${idx+2000}${f.f.name}`,
            data: { type: f.t.shortSignature, fidx: f.t.fields.indexOf(f.f) },
        })),
        // methods
        ...[...methods.values()].map((m,idx) => ({
            label: m.m.shortlabel,
            kind: CompletionItemKind.Method,
            insertText: m.m.name,
            sortText: `${idx+3000}${m.m.name}`,
            data: { type: m.t.shortSignature, midx: m.t.methods.indexOf(m.m) },
        })),
        // types
        ...[...inner_types.values()].map((it,idx) => ({
            label: it.t.simpleTypeName,
            kind: TypeKindMap[it.t.typeKind],
            sortText: `${idx+4000}${it.t.simpleTypeName}`,
            data: { type: it.shortSignature },
        })),
    ]
}
    
/**
 * Return a list of vscode-compatible completion items for a dotted identifier (package or type).
 * 
 * @param {Map<string,CEIType>} typemap Set of known types
 * @param {string} dotted_name 
 * @param {{ statics: boolean }} opts used to control if static or instance members should be included
 */
function getFullyQualifiedDottedIdentCompletion(typemap, dotted_name, opts) {
    if (dotted_name === '') {
        // return the list of top-level package names
        return getTopLevelPackageCompletions(typemap);
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
                            data: null,
                        })
                    }
                } else {
                    // type name
                    arr.push({
                        label: m[1].replace(/\$/g,'.'),
                        kind: CompletionItemKind.Class,
                        data: { type: typename },
                    })
                }
            }
        }
        return arr;
    }, []);
}

/**
 * Return a list of completion items for top-level package names (e.g java, javax, android)
 * 
 * @param {Map<string,CEIType>} typemap
 */
function getTopLevelPackageCompletions(typemap) {
    const pkgs = [...typemap.keys()].reduce((set, short_type_signature) => {
        // the root package is the first part of the short type signature (up to the first /)
        const m = short_type_signature.match(/(.+?)\//);
        m && set.add(m[1]);
        return set;
    }, new Set());

    const items = [...pkgs].filter(x => x)
        .sort()
        .map(package_ident => ({
            label: package_ident,
            kind: CompletionItemKind.Unit,
            sortText: package_ident,
        }));

    return items;
}

/**
 * @param {Map<string,CEIType>} typemap
 * @param {string} pkg
 */
function getPackageCompletion(typemap, pkg) {
    if (pkg === '') {
        return getTopLevelPackageCompletions(typemap);
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
        data: null,
    }));
}

/** Cache of completion items for fixed values, keywords and Android library types */
let defaultCompletionTypes = null;

/** @type {Map<string,CEIType>} */
let lastCompletionTypeMap = null;

let completionRequestCount = 0;

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
                    kind: TypeKindMap[t.typeKind],
                    data: { type: t.shortSignature },
                    sortText: t.dottedTypeName,
                })
            ).sort(sortBy.label),
        // package names
        packageNames: getTopLevelPackageCompletions(lib),
    }
}

function clearDefaultCompletionEntries() {
    defaultCompletionTypes = null;
}

/**
 * Called from the VSCode completion item request.
 * 
 * @param {import('vscode-languageserver').CompletionParams} params
 * @param {Map<string,import('./document').JavaDocInfo>} liveParsers 
 * @param {Map<string,CEIType>|Promise<Map<string,CEIType>>} androidLibrary 
 */
async function getCompletionItems(params, liveParsers, androidLibrary) {
    trace('getCompletionItems');

    if (!params || !params.textDocument || !params.textDocument.uri) {
        return [];
    }

    let dct = defaultCompletionTypes;
    if (!defaultCompletionTypes) {
        initDefaultCompletionTypes(androidLibrary);
        dct = defaultCompletionTypes || {};
    }

    // wait for the Android library to load (in case we receive an early request)
    if (androidLibrary instanceof Promise) {
        androidLibrary = await androidLibrary;
    }

    // retrieve the parsed source corresponding to the request URI
    const docinfo = liveParsers.get(params.textDocument.uri);
    if (!docinfo || !docinfo.parsed) {
        return [];
    }

    // wait for the user to stop typing
    const preversion = docinfo.version;
    await docinfo.reparseWaiter;
    if (docinfo.version !== preversion) {
        // if the file content has changed since this request wss made, ignore it
        trace('content changed - ignoring completion items')
        /** @type {import('vscode-languageserver').CompletionList} */
        return {
            isIncomplete: true,
            items: [],
        }
    }

    completionRequestCount += 1;
    if ((completionRequestCount === 1) || (completionRequestCount === 5) || ((completionRequestCount % 25) === 0)) {
        event('completion-requests', {
            comp_req_count: completionRequestCount, // total count for this session
            comp_req_partial_count: (completionRequestCount % 25) || 25,
        });
    }

    let parsed = docinfo.parsed;

    // save the typemap associated with this parsed state - we use this when resolving
    // the documentation later
    lastCompletionTypeMap = (parsed && parsed.typemap) || androidLibrary;

    let locals = [],
        modifiers = dct.modifiers,
        type_members = [],
        sourceTypes = [];

    if (parsed.unit) {
        const char_index = indexAt(params.position, parsed.content);
        const options = parsed.unit.getCompletionOptionsAt(char_index);
        
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

        // if this token is inside a method, include the parameters and this/super
        if (options.method) {
            locals = options.method.parameters
                .sort(sortBy.name)
                .map(p => ({
                    label: `${p.name}: ${p.type.simpleTypeName}`,
                    insertText: p.name,
                    kind: CompletionItemKind.Variable,
                    sortText: p.name,
                }));
            
            // if this is not a static method, include this/super
            if (!options.method.modifiers.includes('static')) {
                locals.push(...dct.instances);
            }

            type_members = getTypedNameCompletion(
                parsed.typemap,
                options.method.owner.typeSignature,
                { statics: !!options.method.modifierTokens.find(m => m.value === 'static') }
            );

            // if we're inside a method, don't show the modifiers
            modifiers = [];
        }
    }

    // add types currently parsed from the source files
    liveParsers.forEach(doc => {
        if (!doc.parsed) {
            return;
        }
        doc.parsed.unit.types.forEach(
            t => sourceTypes.push({
                label: t.dottedTypeName,
                kind: TypeKindMap[t.typeKind],
                data: { type:t.shortSignature },
                sortText: t.dottedTypeName,
            })
        )
    });

    // exclude dotted (inner) types because they result in useless 
    // matches in the intellisense filter when . is pressed
    const types = [
        ...dct.types,
        ...sourceTypes,
        ].filter(x => !x.label.includes('.'))
        .sort(sortBy.label)

    return [
        ...locals,
        ...type_members,
        ...dct.primitiveTypes,
        ...dct.literals,
        ...modifiers,
        ...types,
        ...dct.packageNames,
    ].map((x,idx) => {
        // to force the order above, reset sortText for each item based upon a fixed-length number
        x.sortText = `${1000+idx}`;
        return x;
    })
}

/**
 * Set the detail and documentation for the specified item
 * 
 * @param {CompletionItem} item
 */
function resolveCompletionItem(item) {
    item.detail = item.documentation = '';
    if (!lastCompletionTypeMap) {
        return item;
    }
    if (!item.data || typeof item.data !== 'object') {
        return item;
    }
    const type = lastCompletionTypeMap.get(item.data.type);
    const field = type && type.fields[item.data.fidx];
    const method = type && type.methods[item.data.midx];
    if (!type) {
        return item;
    }
    let detail, documentation, header;
    if (field) {
        detail = field.label;
        documentation = field.docs;
        header = `${field.type.simpleTypeName} **${field.name}**`;
    } else if (method) {
        detail = `${method.modifiers.filter(m => !/abstract|transient|native/.test(m)).join(' ')} ${type.simpleTypeName}.${method.name}`;
        documentation = method.docs;
        header = method.shortlabel.replace(/^\w+/, x => `**${x}**`).replace(/^(.+?)\s*:\s*(.+)/, (_,a,b) => `${b} ${a}`);
    } else {
        detail = type.fullyDottedRawName,
        documentation = type.docs,
        header = `${type.typeKind} **${type.dottedTypeName}**`;
    }
    item.detail = detail || '';
    item.documentation = formatDoc(header, documentation);
    return item;
}

exports.getCompletionItems = getCompletionItems;
exports.resolveCompletionItem = resolveCompletionItem;
exports.clearDefaultCompletionEntries = clearDefaultCompletionEntries;
