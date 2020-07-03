/**
 * @typedef {Map<string,CEIType>} TypeMap
 */
const { JavaType, CEIType, MethodBase, TypeVariable } = require('java-mti');
const { ResolvedImport } = require('./import-resolver');

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

    if (scope) {

        if (!types[0] && scope instanceof MethodBase) {
            // is it a type variable in the current scope
            const tv = scope.typeVariables.find(tv => tv.name === ident);
            if (tv) {
                types.push(tv.type);
            }
        }

        const scoped_type = scope instanceof CEIType ? scope : scope.owner;
        if (!types[0]) {
            // is it an enclosed type of the currently scoped type or any outer type
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

        if (!types[0]) {
            // is it a type variable of the currently scoped type
            const tv = scoped_type.typeVariables.find(tv => tv.name === ident);
            if (tv) {
                types.push(tv.type);
            }
        }
    }

    if (!types[0]) {
        // is it a type from the imports
        for (let i of imports) {
            const fqn = i.fullyQualifiedNames.find(fqn => fqn.endsWith(ident) && /[$/]/.test(fqn[fqn.length-ident.length-1]));
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
        const { type, sub_package_name } = resolveNextPackage(outer_package_name, ident, typemap);
        if (type) {
            types.push(type);
        }
        package_name = sub_package_name;
    }

    return {
        types,
        package_name,
    }
}

/**
 * 
 * @param {string} package_name 
 * @param {string} ident 
 * @param {TypeMap} typemap 
 */
function resolveNextPackage(package_name, ident, typemap) {
    let type = null, sub_package_name = '';
    const qualified_name = `${package_name}/${ident}`;
    type = typemap.get(qualified_name) || null;
    const package_match = qualified_name + '/';
    if ([...typemap.keys()].find(fqn => fqn.startsWith(package_match))) {
        // it matches a sub-package
        sub_package_name = qualified_name;
    }
    return {
        type,
        sub_package_name
    }
}

module.exports = {
    resolveTypeOrPackage,
    resolveNextTypeOrPackage,
    resolveNextPackage,
}
