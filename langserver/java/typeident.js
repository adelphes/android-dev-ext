const { ArrayType, CEIType, JavaType, PrimitiveType, MethodBase, WildcardType } = require('java-mti');
const { SourceMethod, SourceConstructor, SourceInitialiser } = require('./source-type');
const ResolvedImport = require('./parsetypes/resolved-import');
const { resolveTypeOrPackage, resolveNextTypeOrPackage } = require('./type-resolver');
const { Token } = require('./tokenizer');
const { AnyType } = require("./body-types");

/**
 * @typedef {SourceMethod|SourceConstructor|SourceInitialiser} SourceMC
 * @typedef {import('./TokenList').TokenList} TokenList
 */

 /**
 * @param {TokenList} tokens 
 * @param {CEIType|MethodBase} scope 
 * @param {ResolvedImport[]} imports
 * @param {Map<string,JavaType>} typemap 
 */
function typeIdentList(tokens, scope, imports, typemap) {
    let type = typeIdent(tokens, scope, imports, typemap);
    const types = [type];
    while (tokens.current.value === ',') {
        tokens.inc();
        type = typeIdent(tokens, scope, imports, typemap);
        types.push(type);
    }
    return types;
}

/**
 * @param {TokenList} tokens 
 * @param {CEIType|MethodBase} scope 
 * @param {ResolvedImport[]} imports
 * @param {Map<string,JavaType>} typemap 
 */
function typeIdent(tokens, scope, imports, typemap) {
    /** @type {JavaType[]} */
    let types = [], package_name = '';
    switch(tokens.current.kind) {
        case 'ident':
            ({ types, package_name } = resolveTypeOrPackage(tokens.current.value, scope, imports, typemap));
            break;
        case 'primitive-type':
            types.push(PrimitiveType.fromName(tokens.current.value));
            break;
        default:
            return tokens.current.value === '?'
                ? wildcardTypeArgument(tokens, scope, imports, typemap)
                : AnyType.Instance;
    }
    tokens.inc();
    for (;;) {
        if (tokens.isValue('.')) {
            if (tokens.current.kind !== 'ident') {
                break;
            }
            ({ types, package_name } = resolveNextTypeOrPackage(tokens.current.value, types, package_name, typemap));
            tokens.inc();
        } else if (tokens.isValue('<')) {
            genericTypeArgs(tokens, types, scope, imports, typemap);
        } else if (tokens.isValue('[')) {
            let arrdims = 0;
            for(;;) {
                arrdims++;
                tokens.expectValue(']');
                if (!tokens.isValue('[')) {
                    break;
                }
            }
            if (!types[0]) {
                types.push(AnyType.Instance);
            }
            types = types.map(t => new ArrayType(t, arrdims));
        } else {
            break;
        }
    }

    return types[0] || AnyType.Instance;
}

/**
 * 
 * @param {TokenList} tokens 
 * @param {JavaType[]} types 
 * @param {CEIType|MethodBase} scope 
 * @param {ResolvedImport[]} imports 
 * @param {Map<string,JavaType>} typemap 
 */
function genericTypeArgs(tokens, types, scope, imports, typemap) {
    if (!tokens.isValue('>')) {
        const type_arguments = typeIdentList(tokens, scope, imports, typemap);
        types.forEach((t,i,arr) => {
            if (t instanceof CEIType) {
                let specialised = t.specialise(type_arguments);
                if (typemap.has(specialised.shortSignature)) {
                    arr[i] = typemap.get(specialised.shortSignature);
                    return;
                }
                typemap.set(specialised.shortSignature, specialised);
                arr[i] = specialised;
            }
        });
        if (/>>>?/.test(tokens.current.value)) {
            // we need to split >> and >>> into separate > tokens to handle things like List<Class<?>>
            const new_tokens = tokens.current.value.split('').map((gt,i) => new Token(tokens.current.range.source, tokens.current.range.start + i, 1, 'comparison-operator'));
            tokens.splice(tokens.idx, 1, ...new_tokens);
        }
        tokens.expectValue('>');
    }
}

/**
 * @param {TokenList} tokens 
 * @param {CEIType|MethodBase} scope 
 * @param {ResolvedImport[]} imports
 * @param {Map<string,JavaType>} typemap 
 * @returns {WildcardType}
 */
function wildcardTypeArgument(tokens, scope, imports, typemap) {
    tokens.expectValue('?');
    let bound = null;
    switch (tokens.current.value) {
        case 'extends':
        case 'super':
            const kind = tokens.current.value;
            tokens.inc();
            bound = {
                kind,
                type: typeIdent(tokens, scope, imports, typemap),
            }
            break;
    }
    return new WildcardType(bound);
}

exports.typeIdent = typeIdent;
exports.typeIdentList = typeIdentList;
exports.genericTypeArgs = genericTypeArgs;
