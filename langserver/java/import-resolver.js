
const { ImportBlock } = require('./parser9');
const ResolvedImport = require('./parsetypes/resolved-import');

/**
 * Search a space-separated list of type names for values that match a dotted import.
 * 
 * @param {string} typenames newline-separated list of fully qualified type names
 * @param {string} dotted_import fully-qualified import name (e.g "java.util")
 * @param {boolean} demandload true if this is a demand-load import
 */
function fetchImportedTypes(typenames, dotted_import, demandload) {
    const matcher = demandload
        // for demand-load, we search for any types that begin with the specified import name
        // - note that after the import text, only words and $ are allowed (because additional dots would imply a subpackage)
        ? new RegExp(`^${dotted_import.replace(/\./g, '[/$]')}[/$][\\w$]+$`, 'gm')
        // for exact-load, we search for any types that precisely matches the specified import name
        : new RegExp(`^${dotted_import.replace(/\./g, '[/$]')}$`, 'gm');

    // run the regex against the list of type names
    const matching_names = typenames.match(matcher);
    return matching_names;
}

/**
 * @param {string} typenames newline-separated list of fully qualified type names
 * @param {ImportBlock} import_decl import declaration
 */
function resolveImportTypes(typenames, import_decl) {
    return fetchImportedTypes(typenames, import_decl.name, import_decl.isDemandLoad);
}

/**
 * Resolve a single parsed import
 * 
 * @param {Map<string, import('java-mti').JavaType>} typemap
 * @param {string} dotted_name
 * @param {boolean} is_static
 * @param {boolean} on_demand
 * @param {'owner-package'|'import'|'implicit-import'} import_kind
 */
function resolveSingleImport(typemap, dotted_name, is_static, on_demand, import_kind) {
    // construct the list of typenames
    const typenames = [...typemap.keys()].join('\n');
    const matches = fetchImportedTypes(typenames, dotted_name, on_demand);
    if (matches) {
        return new ResolvedImport(null, matches, typemap, import_kind);
    }
    return null;
}

/**
 * Resolve a set of imports for a module.
 * 
 * Note that the order of the resolved imports is important for correct type resolution:
 *   - same-package imports are first,
 *   - followed by import declarations (in order of declaration),
 *   - followed by implicit packages
 * 
 * @param {Map<string, import('java-mti').JavaType>} androidLibrary
 * @param {import('./source-type').SourceType[]} sourceTypes
 * @param {ImportBlock[]} imports list of declared imports in the module
 * @param {string} package_name package name of the module
 * @param {string[]} [implicitPackages] list of implicit demand-load packages
 */
function resolveImports(androidLibrary, sourceTypes, imports, package_name, implicitPackages = ['java.lang']) {

    const typemap = new Map(androidLibrary);

    sourceTypes.forEach(t => {
        // todo - should we overwrite entries when source types match types in the library?
        typemap.set(t.shortSignature, t);
    })

    // construct the list of typenames
    const typenames = [...typemap.keys()].join('\n');

    /**
     * The list of explicit import declarations we are unable to resolve
     * @type {ImportBlock[]}
     */
    const unresolved = [];

    /** @type {ResolvedImport[]} */
    const resolved = [];

    // import types matching the current package
    if (package_name) {
        const matches = fetchImportedTypes(typenames, package_name, true);
        if (matches)
            resolved.push(new ResolvedImport(null, matches, typemap, 'owner-package'));
    }

    // import types from each import declaration
    imports.forEach(import_decl => {
        const matches = resolveImportTypes(typenames, import_decl);
        if (matches) {
            resolved.push(new ResolvedImport(import_decl, matches, typemap, 'import'));
        } else {
            // if we cannot match the import to any types, add it to the unresolved list so
            // we can flag it as a warning later.
            // Note that empty packages (packages with no types) will appear here - they
            // are technically valid, but represent useless imports
            unresolved.push(import_decl);
        }
    });

    // import types from the implicit packages
    implicitPackages.forEach(package_name => {
        const matches = fetchImportedTypes(typenames, package_name, true);
        if (matches)
            resolved.push(new ResolvedImport(null, matches, typemap, 'implicit-import'));
    })

    /**
     * return the resolved and unresolved imports.
     * The typemap is also included to support fully qualified type names that, by virtue of 
     * being fully-qualified, don't require importing.
     */
    return {
        resolved,
        unresolved,
        typemap,
    }
}

module.exports = {
    resolveImports,
    resolveSingleImport,
    ResolvedImport,
}
