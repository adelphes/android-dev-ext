/**
 * @typedef {Map<string,CEIType>} TypeMap
 */
const { JavaType, PrimitiveType, ArrayType, CEIType, MethodBase, TypeVariable } = require('java-mti');
const { ResolvedImport } = require('./import-resolver');
const ResolvedType = require('./parsetypes/resolved-type');

/**
 * Parse a type into its various components
 * @param {string} label 
 * @returns {{type:ResolvedType, error:string}}
 */
function parse_type(label) {
    const type = new ResolvedType();
    let re = /([a-zA-Z_]\w*(?:\.[a-zA-Z_]\w*)*)|(\.[a-zA-Z_]\w*)|[<,>]|((?:\[\])+)|( +)|./g;
    let parts = [type.addTypePart()];
    for (let m; m = re.exec(label);) {
        if (m[4]) {
            // ignore ws
            continue;
        }
        if (!parts[0].name) {
            if (m[1]) {
                parts[0].name = m[1];
                continue;
            }
            return { type, error: 'Missing type identifier' };
        }
        if (m[0] === '<') {
            if (!parts[0].typeargs && !parts[0].owner.arrdims) {
                // start of type arguments - start a new type
                const t = new ResolvedType(true);
                parts[0].typeargs = [t];
                parts.unshift(t.addTypePart());
                continue;
            }
            return { type, error: `Unexpected '<' character` };
        }
        if (m[0] === ',') {
            if (parts[1] && parts[1].typeargs) {
                // type argument separator - replace the type on the stack
                const t = new ResolvedType(true);
                parts[1].typeargs.push(t);
                parts[0] = t.addTypePart();
                continue;
            }
            return { type, error: `Unexpected ',' character` };
        }
        if (m[0] === '>') {
            if (parts[1] && parts[1].typeargs) {
                // end of type arguments
                parts.shift();
                continue;
            }
            return { type, error: `Unexpected '>' character` };
        }
        if (m[2]) {
            if (parts[0].typeargs || parts[0].outer) {
                // post-type-args enclosed type
                parts[0] = parts[0].inner = parts[0].owner.addTypePart(m[2].slice(1), parts[0]);
                continue;
            }
            return { type, error: `Unexpected '.' character` };
        }
        if (m[3]) {
            parts[0].owner.arrdims = m[3].length / 2;
            continue;
        }
        return { type, error: `Invalid type` };
    }

    if (parts.length !== 1) {
        // one or more missing >
        return { type, error: `Missing >` };
    }

    return { type, error: '' };
}


/**
 * Construct a regex to search for an enclosed type in the current and outer scopes of a given type
 * 
 * @param {string} fully_qualified_scope the JRE name (a.b.X$Y) of the current type scope
 * @param {string} dotted_raw_typename the dotted name of the type we are searching for
 */
function createTypeScopeRegex(fully_qualified_scope, dotted_raw_typename) {
    // split the type name across enclosed type boundaries
    const scopes = fully_qualified_scope.split('$');

    // if the typename we are searching represents an enclosed type, the type-qualifier dots must be replaced with $
    const enclosed_raw_typename = dotted_raw_typename.replace(/\./g,'[$]');

    // bulld up the list of possible type matches based upon each outer scope of the type
    const enclosed_type_regexes = [];
    while (scopes.length) {
        enclosed_type_regexes.push(`${scopes.join('[$]')}[$]${enclosed_raw_typename}`);
        scopes.pop();
    }
    // the final regex is an exact match of possible type names, sorted from inner scope to outer (top-level) scope
    return new RegExp(`^(${enclosed_type_regexes.join('|')})$`);
}

/**
  * Locate JavaTypes that match a type label.
  * @param {string} type_label The type to resolve
  * @param {string} fully_qualified_scope The fully-qualified JRE name of the current type scope.
  * @param {ResolvedImport[]} resolved_imports The list of types resolved from the imports
  * @param {TypeMap} typemap 
  */
function resolveType(type_label, fully_qualified_scope, resolved_imports, typemap) {
    const { type, error } = parse_type(type_label);
    if (error) {
        // don't try to find the type if the parsing failed
        type.error = error;
        return type;
    }

    // locate the JavaTypes for the type and type arguments
    resolveCompleteType(type, fully_qualified_scope, resolved_imports, typemap);
    return type;
}

/**
 * 
 * @param {ResolvedType} type 
 * @param {string} fully_qualified_scope 
 * @param {ResolvedImport[]} resolved_imports 
 * @param {TypeMap} typemap 
 */
function resolveCompleteType(type, fully_qualified_scope, resolved_imports, typemap) {

    type.mtis = findJavaTypes(type.getDottedRawType(), type.arrdims, fully_qualified_scope, resolved_imports, typemap);

    // resolve type arguments
    type.parts.filter(p => p.typeargs).forEach(p => {
        p.typeargs.forEach(typearg => {
            resolveCompleteType(typearg, fully_qualified_scope, resolved_imports, typemap);
        })
    })
}


/**
 * @param {string} dotted_raw_typename
 * @param {number} arraydims
 * @param {string} fully_qualified_scope The fully-qualified JRE name of the current type scope.
 * @param {ResolvedImport[]} resolved_imports The list of types resolved from the imports
 * @param {TypeMap} typemap 
 */
function findJavaTypes(dotted_raw_typename, arraydims, fully_qualified_scope, resolved_imports, typemap) {
    let types = findRawJavaTypes(dotted_raw_typename, fully_qualified_scope, resolved_imports, typemap);

    if (arraydims > 0) {
        // convert matches to array types
        const array_types = types.map(t => new ArrayType(t, arraydims));
        return array_types;
    }

    return types;
}

/**
 * Match a dotted type name to one or more JavaTypes
 * @param {string} dotted_raw_typename
 * @param {string} fully_qualified_scope The fully-qualified JRE name of the current type scope.
 * @param {TypeMap} typemap 
 * @param {ResolvedImport[]} resolved_imports The list of types resolved from the imports
 * @returns {(PrimitiveType|CEIType)[]}
 */
function findRawJavaTypes(dotted_raw_typename, fully_qualified_scope, resolved_imports, typemap) {

    // first check if it's a simple primitive
    if (PrimitiveType.isPrimitiveTypeName(dotted_raw_typename)) {
        // return the primitive type
        return [PrimitiveType.fromName(dotted_raw_typename)];
    }

    // create a regex to search for the type name
    // - the first search is for exact type matches inside the current type scope (and any parent type scopes)
    let search = createTypeScopeRegex(fully_qualified_scope, dotted_raw_typename); 
    let matched_types = 
        resolved_imports.map(ri => ({
            ri,
            mtis: ri.fullyQualifiedNames.filter(fqn => search.test(fqn)).map(fqn => ri.types.get(fqn))
        }))
        .filter(x => x.mtis.length);

    if (!matched_types.length) {
        // if the type was not found in the current type scope, construct a new search for the imported types.
        // - since we don't know if the type name includes package qualifiers or not, this regex allows for implicit
        //   package prefixes (todo - need to figure out static type imports)
        search = new RegExp(`^(.+?/)?${dotted_raw_typename.replace(/\./g,'[/$]')}$`);

        // search the imports for the type
        matched_types = 
            resolved_imports.map(ri => ({
                ri,
                mtis: ri.fullyQualifiedNames.filter(fqn => search.test(fqn)).map(fqn => ri.types.get(fqn))
            }))
            .filter(x => x.mtis.length);
    }

    // if the type matches multiple import entries, exact imports take prioirity over demand-load imports
    let exact_import_matches = matched_types.filter(x => x.ri.import && !x.ri.import.isDemandLoad);
    if (exact_import_matches.length) {
        if (exact_import_matches.length < matched_types.length) {
            matched_types = exact_import_matches;
        }
    }

    if (!matched_types.length) {
        // if the type doesn't match any import, the final option is a fully qualified match across all types in all libraries
        search = new RegExp(`^${dotted_raw_typename.replace(/\./g,'[/$]')}$`);
        for (let typename of typemap.keys()) {
            if (search.test(typename)) {
                matched_types = [{
                    ri: null,
                    mtis: [typemap.get(typename)]
                }];
                break;
            }
        }
    }

    // at this point, we should (hopefully) have a single matched type
    // - if the matched_types array is empty, the type is not found
    // - if the matched_type array has more than one entry, the type matches types across multiple imports
    // - if the matched_type array has one entry and multiple MTIs, the type matches multiple types in a single import
    return matched_types
        .reduce((types, type) => [...types, ...type.mtis] , [])
}

/**
 * Converts an array of type name strings to resolved types
 * @param {string[]} types
 * @param {string} fully_qualified_scope the JRE name of the type scope we are resolving in
 * @param {ResolvedImport[]} resolved_imports the list of resolved imports (and types associated with them)
 * @param {TypeMap} typemap 
 */
function resolveTypes(types, fully_qualified_scope, resolved_imports, typemap) {
    return types.map(typename => resolveType(typename, fully_qualified_scope, resolved_imports, typemap));
}

/**
 * Converts an array of TypeIdent instances to resolved types
 * @param {import('./parsetypes/typeident')[]} types
 * @param {string} fully_qualified_scope the JRE name of the type scope we are resolving in
 * @param {ResolvedImport[]} resolved_imports the list of resolved imports (and types associated with them)
 * @param {TypeMap} typemap 
 */
function resolveTypeIdents(types, fully_qualified_scope, resolved_imports, typemap) {
    const names = types.map(typeident => 
        typeident.tokens.map(token => token.text).join('')
    );
    return resolveTypes(names, fully_qualified_scope, resolved_imports, typemap);
}


/**
 * 
 * @param {string} ident 
 * @param {TypeVariable[]} type_variables 
 * @param {CEIType|MethodBase} scope 
 * @param {ResolvedImport[]} imports 
 * @param {TypeMap} typemap 
 */
function resolveTypeOrPackage(ident, type_variables, scope, imports, typemap) {
    const types = [];
    let package_name = '';

    const tv = type_variables.find(tv => tv.name === ident);
    if (tv) {
        types.push(tv.type);
    }

    if (!types[0] && scope instanceof MethodBase) {
        // is it a type variable in the current scope
        const tv = scope.typeVariables.find(tv => tv.name === ident);
        if (tv) {
            types.push(tv.type);
        }
    }

    if (!types[0] && scope) {
        // is it an enclosed type of the currently scoped type or any outer type
        const scoped_type = scope instanceof CEIType ? scope : scope.owner;
        const scopes = scoped_type.shortSignature.split('$');
        while (scopes.length) {
            const enc_type = typemap.get(`${scopes.join('$')}$${ident}`);
            if (enc_type) {
                types.push(enc_type);
                break;
            }
            scopes.pop();
        }
        if (!types[0] && scoped_type.simpleTypeName === ident) {
            types.push(scoped_type);
        }
    }

    if (!types[0] && scope instanceof CEIType) {
        // is it a type variable of the currently scoped type
        const tv = scope.typeVariables.find(tv => tv.name === ident);
        if (tv) {
            types.push(tv.type);
        }
    }

    if (!types[0]) {
        // is it a top-level type from the imports
        const top_level_type = '/' + ident;
        for (let i of imports) {
            const fqn = i.fullyQualifiedNames.find(fqn => fqn.endsWith(top_level_type));
            if (fqn) {
                types.push(i.types.get(fqn));
            }
        }
    }

    if (!types[0]) {
        // is it a default-package type 
        const default_type = typemap.get(ident);
        if (default_type) {
            types.push(default_type);
        }
    }

    // the final option is the start of a package name
    const package_root = ident + '/';
    const typelist = [...typemap.keys()];
    if (typelist.find(fqn => fqn.startsWith(package_root))) {
        package_name = ident;        
    }

    return {
        types,
        package_name,
    }
}

/**
 * 
 * @param {string} ident 
 * @param {JavaType[]} outer_types 
 * @param {string} outer_package_name 
 * @param {TypeMap} typemap 
 */
function resolveNextTypeOrPackage(ident, outer_types, outer_package_name, typemap) {
    const types = [];
    let package_name = '';

    outer_types.forEach(type => {
        if (type instanceof CEIType) {
            const enclosed_type_signature = `${type.shortSignature}$${ident}`;
            const enclosed_type = typemap.get(enclosed_type_signature);
            if (enclosed_type) {
                // it matches an inner/enclosed type
                types.push(enclosed_type);
            }
        }
    })

    if (outer_package_name) {
        const type_match = `${outer_package_name}/${ident}`;
        if (typemap.has(type_match)) {
            // it matches a type
            types.push(typemap.get(type_match));
        }
        const package_match = type_match + '/';
        if ([...typemap.keys()].find(fqn => fqn.startsWith(package_match))) {
            // it matches a sub-package
            package_name = type_match;
        }
    }

    return {
        types,
        package_name,
    }
}

module.exports = {
    parse_type,
    resolveType,
    resolveTypes,
    resolveTypeIdents,
    ResolvedType,
    resolveTypeOrPackage,
    resolveNextTypeOrPackage,
}
