const { JavaType, WildcardType } = require('java-mti');
const { SourceMethod, SourceConstructor, SourceInitialiser } = require('./source-type');
const ResolvedImport = require('./parsetypes/resolved-import');
const { resolveTypeOrPackage, resolveNextTypeOrPackage } = require('./type-resolver');
const { Token } = require('./tokenizer');
const { AnyType, ResolvedIdent } = require("./body-types");

/**
 * @typedef {SourceMethod|SourceConstructor|SourceInitialiser} SourceMC
 * @typedef {import('./TokenList').TokenList} TokenList
 */

 /**
 * @param {TokenList} tokens 
 * @param {SourceMC} method 
 * @param {ResolvedImport[]} imports
 * @param {Map<string,JavaType>} typemap 
 */
function typeIdentList(tokens, method, imports, typemap) {
    let type = typeIdent(tokens, method, imports, typemap);
    const types = [type];
    while (tokens.current.value === ',') {
        tokens.inc();
        type = typeIdent(tokens, method, imports, typemap);
        types.push(type);
    }
    return types;
}

/**
 * @param {TokenList} tokens 
 * @param {SourceMC} method 
 * @param {ResolvedImport[]} imports
 * @param {Map<string,JavaType>} typemap 
 */
function typeIdent(tokens, method, imports, typemap) {
    if (tokens.current.kind !== 'ident') {
        if (tokens.current.value === '?') {
            return wildcardTypeArgument(tokens, method, imports, typemap);
        }
        return AnyType.Instance;
    }
    const { types, package_name } = resolveTypeOrPackage(tokens.current.value, method._owner, imports, typemap);
    tokens.inc();
    for (;;) {
        if (tokens.isValue('.')) {
            if (tokens.current.kind !== 'ident') {
                break;
            }
            resolveNextTypeOrPackage(tokens.current.value, types, package_name, typemap);
        } else if (tokens.isValue('<')) {
            if (!tokens.isValue('>')) {
                typeIdentList(tokens, method, imports, typemap);
                if (/>>>?/.test(tokens.current.value)) {
                    // we need to split >> and >>> into separate > tokens to handle things like List<Class<?>>
                    const new_tokens = tokens.current.value.split('').map((gt,i) => new Token(tokens.current.range.source, tokens.current.range.start + i, 1, 'comparison-operator'));
                    tokens.splice(tokens.idx, 1, ...new_tokens);
                }
                tokens.expectValue('>');
            }
        } else {
            break;
        }
    }

    return types[0] || AnyType.Instance;
}

/**
 * @param {TokenList} tokens 
 * @param {SourceMC} method 
 * @param {ResolvedImport[]} imports
 * @param {Map<string,JavaType>} typemap 
 * @returns {WildcardType}
 */
function wildcardTypeArgument(tokens, method, imports, typemap) {
    tokens.expectValue('?');
    let bound = null;
    switch (tokens.current.value) {
        case 'extends':
        case 'super':
            const kind = tokens.current.value;
            tokens.inc();
            bound = {
                kind,
                type: typeIdent(tokens, method, imports, typemap),
            }
            break;
    }
    return new WildcardType(bound);
}

exports.typeIdent = typeIdent;
exports.typeIdentList = typeIdentList;
