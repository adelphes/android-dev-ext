const { ModuleBlock, TypeDeclBlock } = require('../parser9');
const ParseProblem = require('../parsetypes/parse-problem');
const {SourceType} = require('../source-type');
const {JavaType, CEIType, TypeArgument, UnresolvedType} = require('java-mti')

/**
 * @param {JavaType} type 
 */
function checkType(type, typeTokens, probs) {
    if (type instanceof UnresolvedType) {
        probs.push(ParseProblem.Error(typeTokens, `Unknown type: ${type.label}`));
        return;
    }
    if (type instanceof CEIType) {
        type.typeVariables.forEach(tv => {
            if (tv instanceof TypeArgument) {
                checkType(tv.type, typeTokens, probs);
            }
        })
    }
}

/**
 * @param {SourceType} type 
 * @param {*} probs 
 */
function checkUnresolvedTypes(type, probs) {
    type.extends_types.forEach(superclass => checkType(superclass.resolved, superclass.typeTokens, probs));
    type.implements_types.forEach(superintf => checkType(superintf.resolved, superintf.typeTokens, probs));
    type.fields.forEach(f => checkType(f.type, f._decl.typeTokens, probs));
    type.methods.forEach(m => {
        checkType(m.returnType, m._decl.typeTokens, probs);
        m.parameters.forEach(p => {
            checkType(p.type, p._decl.typeTokens, probs);
        })
    })
}


/**
 * @param {ModuleBlock} mod 
 * @param {*} imports
 * @param {SourceType[]} source_types
 */
module.exports = function(mod, imports, source_types) {
    /** @type {ParseProblem[]} */
    const probs = [];
      
    source_types.forEach(type => checkUnresolvedTypes(type, probs));
      
    return probs;
}
