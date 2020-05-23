const { ModuleBlock, TypeDeclBlock } = require('./parser9');
const { resolveImports } = require('../java/import-resolver');
const MTI = require('./mti');


/**
 * @param {string} package_name
 * @param {string} owner_typename
 * @param {ModuleBlock|TypeDeclBlock} parent 
 * @param {MTI.Type[]} mtis 
 */
function getSourceMTIs(package_name, owner_typename, parent, mtis) {
    parent.types.forEach(type => {
        const mods = type.modifiers.map(m => m.source);
        const qualifiedTypeName = `${owner_typename}${type.simpleName}`;
        // we add the names of type variables here, but we resolve any bounds later
        const typevar_names = type.typevars.map(tv => tv.name);
        const mti = new MTI().addType(package_name, '', mods, type.kind(), qualifiedTypeName, typevar_names);
        mtis.push(mti);
        getSourceMTIs(package_name, `${qualifiedTypeName}$`, type, mtis);
    });
}

/**
 * @param {ModuleBlock} mod 
 */
function validate(mod, androidLibrary) {
    console.time('validation');

    const source_mtis = [];
    getSourceMTIs(mod.packageName, '', mod, source_mtis);

    const imports = resolveImports(androidLibrary, mod.imports, mod.packageName, source_mtis);

    const module_validaters = [
        require('./validation/multiple-package-decls'),
        require('./validation/unit-decl-order'),
        require('./validation/duplicate-members'),
        require('./validation/parse-errors'),
        require('./validation/modifier-errors'),
        require('./validation/unresolved-imports'),
        require('./validation/resolved-types'),
    ];
    let problems = [
        module_validaters.map(v => v(mod, imports)),
    ];
    console.timeEnd('validation');

    function flatten(arr) {
        let res = arr;
        for (;;) {
            const idx = res.findIndex(x => Array.isArray(x));
            if (idx < 0) {
                return res;
            }
            res = [...res.slice(0, idx), ...res[idx], ...res.slice(idx+1)]
        }
    }

    let flattened = flatten(problems).filter(x => x);
    return flattened;
}

module.exports = {
    validate,
}
