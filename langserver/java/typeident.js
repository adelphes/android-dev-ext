const { ArrayType, CEIType, JavaType, WildcardType } = require('java-mti');
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
 * @param {CEIType} scoped_type 
 * @param {ResolvedImport[]} imports
 * @param {Map<string,JavaType>} typemap 
 */
function typeIdentList(tokens, scoped_type, imports, typemap) {
    let type = typeIdent(tokens, scoped_type, imports, typemap);
    const types = [type];
    while (tokens.current.value === ',') {
        tokens.inc();
        type = typeIdent(tokens, scoped_type, imports, typemap);
        types.push(type);
    }
    return types;
}

/**
 * @param {TokenList} tokens 
 * @param {CEIType} scoped_type 
 * @param {ResolvedImport[]} imports
 * @param {Map<string,JavaType>} typemap 
 */
function typeIdent(tokens, scoped_type, imports, typemap) {
    if (tokens.current.kind !== 'ident') {
        if (tokens.current.value === '?') {
            return wildcardTypeArgument(tokens, scoped_type, imports, typemap);
        }
        return AnyType.Instance;
    }
    let { types, package_name } = resolveTypeOrPackage(tokens.current.value, scoped_type, imports, typemap);
    tokens.inc();
    for (;;) {
        if (tokens.isValue('.')) {
            if (tokens.current.kind !== 'ident') {
                break;
            }
            resolveNextTypeOrPackage(tokens.current.value, types, package_name, typemap);
        } else if (tokens.isValue('<')) {
            if (!tokens.isValue('>')) {
                typeIdentList(tokens, scoped_type, imports, typemap);
                if (/>>>?/.test(tokens.current.value)) {
                    // we need to split >> and >>> into separate > tokens to handle things like List<Class<?>>
                    const new_tokens = tokens.current.value.split('').map((gt,i) => new Token(tokens.current.range.source, tokens.current.range.start + i, 1, 'comparison-operator'));
                    tokens.splice(tokens.idx, 1, ...new_tokens);
                }
                tokens.expectValue('>');
            }
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
 * @param {TokenList} tokens 
 * @param {CEIType} scoped_type 
 * @param {ResolvedImport[]} imports
 * @param {Map<string,JavaType>} typemap 
 * @returns {WildcardType}
 */
function wildcardTypeArgument(tokens, scoped_type, imports, typemap) {
    tokens.expectValue('?');
    let bound = null;
    switch (tokens.current.value) {
        case 'extends':
        case 'super':
            const kind = tokens.current.value;
            tokens.inc();
            bound = {
                kind,
                type: typeIdent(tokens, scoped_type, imports, typemap),
            }
            break;
    }
    return new WildcardType(bound);
}

exports.typeIdent = typeIdent;
exports.typeIdentList = typeIdentList;
