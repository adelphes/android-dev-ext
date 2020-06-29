
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
 * Resolve a single parsed import
 * 
 * @param {Map<string, import('java-mti').CEIType>} typemap
 * @param {string} dotted_name
 * @param {boolean} is_static
 * @param {boolean} on_demand
 * @param {'owner-package'|'import'|'implicit-import'} import_kind
 */
function resolveSingleImport(typemap, dotted_name, is_static, on_demand, import_kind) {
    // construct the list of typenames
    const typenames = [...typemap.keys()].join('\n');

    if (is_static) {
        if (on_demand) {
            // import all static members - the dotted name must be an exact type
            const matches = fetchImportedTypes(typenames, dotted_name, false);
            if (matches) {
                return new ResolvedImport(matches, '*', typemap, import_kind);
            }
        } else if (dotted_name.includes('.')) {
            // the final ident is the static member - the rest is the exact type
            const split_name = dotted_name.match(/(.+)\.([^.]+)$/);
            const matches = fetchImportedTypes(typenames, split_name[1], false);
            if (matches) {
                const i = new ResolvedImport(matches, split_name[2], typemap, import_kind);
                // if there's no matching member, treat it as an invalid import
                if (i.members.length > 0) {
                    return i;
                }
            }
        }
    } else {
        const matches = fetchImportedTypes(typenames, dotted_name, on_demand);
        if (matches) {
            return new ResolvedImport(matches, null, typemap, import_kind);
        }
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
 * @param {Map<string, import('java-mti').CEIType>} typemap
 * @param {string} package_name package name of the module
 * @param {string[]} [implicitPackages] list of implicit demand-load packages
 */
function resolveImports(typemap, package_name, implicitPackages = ['java.lang']) {

    // construct the list of typenames
    const typenames = [...typemap.keys()].join('\n');

    /** @type {ResolvedImport[]} */
    const resolved = [];

    // import types matching the current package
    if (package_name) {
        const matches = fetchImportedTypes(typenames, package_name, true);
        if (matches)
            resolved.push(new ResolvedImport(matches, null, typemap, 'owner-package'));
    }

    // import types from the implicit packages
    implicitPackages.forEach(package_name => {
        const matches = fetchImportedTypes(typenames, package_name, true);
        if (matches)
            resolved.push(new ResolvedImport(matches, null, typemap, 'implicit-import'));
    })

    /**
     * return the resolved imports.
     */
    return resolved;
}

module.exports = {
    resolveImports,
    resolveSingleImport,
    ResolvedImport,
}
