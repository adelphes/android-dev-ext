const { JavaType } = require('java-mti');
const { ModuleBlock, TypeDeclBlock } = require('./parser9');
const { resolveImports } = require('../java/import-resolver');
const ResolvedImport = require('../java/parsetypes/resolved-import');
const { SourceType, SourceMethod, SourceConstructor, ResolvableType } = require('./source-type');
const { parseBody, flattenBlocks } = require('./body-parser3');
const { TokenList } = require('./TokenList');
const { typeIdent } = require('./typeident');


/**
 * @param {ModuleBlock} mod
 * @param {string} owner_typename
 * @param {ModuleBlock|TypeDeclBlock} parent 
 * @param {SourceType[]} source_types 
 * @param {Map<string,JavaType>} typemap
 */
function getSourceTypes(mod, owner_typename, parent, source_types, typemap) {
    parent.types.forEach(type => {
        const qualifiedTypeName = `${owner_typename}${type.simpleName}`;
        // we add the names of type variables here, but we resolve any bounds later
        //const typevar_names = type.typevars.map(tv => tv.name);
        //const mti = new MTI().addType(package_name, '', mods, type.kind(), qualifiedTypeName, typevar_names);
        const t = new SourceType(mod, type, qualifiedTypeName, typemap);
        source_types.push(t);
        getSourceTypes(mod, `${qualifiedTypeName}$`, type, source_types, typemap);
    });
}

/**
 * @param {ResolvableType} rt 
 * @param {SourceType|SourceMethod|SourceConstructor} scope 
 * @param {ResolvedImport[]} resolved_imports 
 * @param {Map<string,JavaType>} typemap 
 */
function resolveResolvableType(rt, scope, resolved_imports, typemap) {
    const tokens = new TokenList(flattenBlocks(rt.typeTokens, false));
    rt._resolved = typeIdent(tokens, scope, resolved_imports, typemap);
}

/**
 * 
 * @param {SourceType} source_type 
 * @param {ResolvedImport[]} resolved_imports 
 * @param {Map<string,JavaType>} typemap 
 */
function resolveResolvableTypes(source_type, resolved_imports, typemap) {
    source_type.extends_types.forEach(rt => resolveResolvableType(rt, source_type, resolved_imports, typemap));
    source_type.implements_types.forEach(rt => resolveResolvableType(rt, source_type, resolved_imports, typemap));

    source_type.fields.forEach(f => resolveResolvableType(f._type, source_type, resolved_imports, typemap));

    // methods and constructors can have parameterized types
    source_type.methods.forEach(m => {
        resolveResolvableType(m._returnType, m, resolved_imports, typemap);
        m.parameters.forEach(p => resolveResolvableType(p._paramType, m, resolved_imports, typemap));
    });

    source_type.declaredConstructors.forEach(c => {
        c.parameters.forEach(p => resolveResolvableType(p._paramType, c, resolved_imports, typemap));
    });
}

/**
 * @param {ModuleBlock} mod 
 * @param {Map<string, JavaType>} androidLibrary
 */
function validate(mod, androidLibrary) {
    console.time('validation');

    /** @type {SourceType[]} */
    const source_types = [];
    getSourceTypes(mod, '', mod, source_types, androidLibrary);

    const imports = resolveImports(androidLibrary, source_types, mod.imports, mod.packageName);

    source_types.forEach(t => {
        resolveResolvableTypes(t, imports.resolved, imports.typemap);
    });

    let probs = [];
    source_types.forEach(t => {
        t.initers.forEach(i => {
            console.log('<clinit>()');
            const parsed = parseBody(i, imports.resolved, imports.typemap);
            if (parsed)
                probs = probs.concat(parsed.problems)
        })
        t.declaredConstructors.forEach(c => {
            console.log(c.label);
            const parsed = parseBody(c, imports.resolved, imports.typemap);
            if (parsed)
                probs = probs.concat(parsed.problems)
        })
        t.methods.forEach(m => {
            console.log(m.label);
            const parsed = parseBody(m, imports.resolved, imports.typemap);
            if (parsed)
                probs = probs.concat(parsed.problems)
        })
    })

    const module_validaters = [
        require('./validation/multiple-package-decls'),
        require('./validation/unit-decl-order'),
        require('./validation/duplicate-members'),
        require('./validation/parse-errors'),
        require('./validation/modifier-errors'),
        require('./validation/unresolved-imports'),
        require('./validation/unresolved-types'),
        require('./validation/invalid-types'),
        require('./validation/bad-extends'),
        require('./validation/bad-implements'),
        require('./validation/non-implemented-interfaces'),
        require('./validation/bad-overrides'),
        require('./validation/missing-constructor'),
    ];
    let problems = [
        module_validaters.map(v => v(mod, imports, source_types)),
        ...probs,
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
    console.log(`Problems: ${flattened.length}`)
    return flattened;
}

module.exports = {
    validate,
}
