const { ArrayType, JavaType, TypeVariable } = require('java-mti');
const { ModuleBlock, TypeDeclBlock } = require('./parser9');
const { resolveImports } = require('../java/import-resolver');
const ResolvedImport = require('../java/parsetypes/resolved-import');
const { SourceType, SourceTypeIdent, SourceField, SourceMethod, SourceConstructor, SourceInitialiser, SourceParameter, SourceAnnotation } = require('./source-type');
const { parseBody, flattenBlocks } = require('./body-parser3');
const { TokenList } = require('./TokenList');
const { typeIdent } = require('./typeident');


/**
 * @param {ModuleBlock} mod
 * @param {SourceType} outer_type
 * @param {ModuleBlock|TypeDeclBlock} parent 
 * @param {SourceType[]} source_types 
 * @param {Map<string,JavaType>} typemap
 */
function getSourceTypes(mod, outer_type, parent, source_types, typemap) {
    parent.types.forEach(type => {
        const t = new SourceType(mod.packageName, outer_type, '', type.modifiers.map(m => m.value), type.kindToken, type.name_token, typemap);
        t.typeVariables = type.typevars.map(tv => new TypeVariable(t, tv.name, [new TypeVariable.Bound(t, 'Ljava/lang/Object;', false)]));
        source_types.push(t);
        getSourceTypes(mod, t, type, source_types, typemap);
    });
}

/**
 * @param {TokenList} tokens
 * @param {ModuleBlock|TypeDeclBlock} parent 
 * @param {ResolvedImport[]} imports 
 * @param {Map<string,JavaType>} typemap
 */
function populateTypes(tokens, parent, imports, typemap) {

    parent.types.forEach(type => {
        const source_type = typemap.get(type.shortSignature);
        if (source_type instanceof SourceType) {
            if (type.extends_decl)
                source_type.extends_types = resolveTypeList(source_type, type.extends_decl);
            if (type.implements_decl)
                source_type.implements_types = resolveTypeList(source_type, type.implements_decl);
            
            // fields
            source_type.fields = type.fields.map(f => {
                const field_type = resolveTypeFromTokens(source_type, f);
                return new SourceField(source_type, f.modifiers, field_type, f.name_token);
            });
            // methods
            source_type.methods = type.methods.map(m => {
                const method_type = resolveTypeFromTokens(source_type, m);
                const params = m.parameters.map(p => {
                    let param_type = resolveTypeFromTokens(source_type, p);
                    return new SourceParameter(p.modifiers, param_type, p.isVarArgs, p.name_token);
                })
                const annotations = m.annotations.map(a => new SourceAnnotation(resolveTypeFromTokens(source_type, {typeTokens: [a.blockArray().blocks.slice().pop()]})))
                return new SourceMethod(source_type, m.modifiers, annotations, method_type, m.name_token, params, [], flattenBlocks([m.body()], true));
            })
            // constructors
            source_type.constructors = type.constructors.map(c => {
                const params = c.parameters.map(p => {
                    const param_type = resolveTypeFromTokens(source_type, p);
                    return new SourceParameter(p.modifiers, param_type, p.isVarArgs, p.name_token);
                })
                return new SourceConstructor(source_type, c.modifiers, params, [], flattenBlocks([c.body()], true));
            })
            // initialisers
            source_type.initers = type.initialisers.map(i => {
                return new SourceInitialiser(source_type, i.modifiers, flattenBlocks([i.body()], true));
            })
        }
        populateTypes(tokens, type, imports, typemap);
    });

    function resolveTypeFromTokens(scope, decl) {
        const typetokens = flattenBlocks([decl.typeTokens[0]], false);
        tokens.current = tokens.tokens[tokens.idx = tokens.tokens.indexOf(typetokens[0])];
        let type = typeIdent(tokens, scope, imports, typemap);
        if (decl.varBlock && decl.varBlock.post_name_arr_token) {
            type = new ArrayType(type, decl.varBlock.post_name_arr_token.source.replace(/[^\[]/g,'').length);
        }
        if (decl.isVarArgs) {
            type = new ArrayType(type, 1);
        }
        return new SourceTypeIdent(typetokens, type);
    }

    function resolveTypeList(scope, eit_decl) {
        const types = [];
        const eit_tokens = flattenBlocks([eit_decl], false);
        tokens.current = tokens.tokens[tokens.idx = tokens.tokens.indexOf(eit_tokens[0])];
        tokens.inc();   // bypass extends/implements/throws keyword
        for (;;) {
            const start = tokens.idx;
            const type = typeIdent(tokens, scope, imports, typemap);
            let end = tokens.idx - 1;
            while (tokens.tokens[end].kind === 'wsc') {
                end -= 1;
            }
            types.push(new SourceTypeIdent(tokens.tokens.slice(start, end + 1), type));
            if (!tokens.isValue(',')) {
                break;
            }
        }
        return types;
    }
}


/**
 * @param {ModuleBlock} mod 
 * @param {Map<string, JavaType>} androidLibrary
 */
function validate(mod, androidLibrary) {
    console.time('validation');

    /** @type {SourceType[]} */
    const source_types = [];
    getSourceTypes(mod, null, mod, source_types, androidLibrary);

    const imports = resolveImports(androidLibrary, source_types, mod.imports, mod.packageName);

    populateTypes(new TokenList(flattenBlocks(mod.blocks, false)), mod, imports.resolved, imports.typemap);

    let probs = [];
    source_types.forEach(t => {
        t.initers.forEach(i => {
            const parsed = parseBody(i, imports.resolved, imports.typemap);
            if (parsed)
                probs = probs.concat(parsed.problems)
        })
        t.constructors.forEach(c => {
            const parsed = parseBody(c, imports.resolved, imports.typemap);
            if (parsed)
                probs = probs.concat(parsed.problems)
        })
        t.methods.forEach(m => {
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
