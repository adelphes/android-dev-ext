const { ModuleBlock, TypeDeclBlock } = require('../parser9');
const ParseProblem = require('../parsetypes/parse-problem');
const {SourceType} = require('../source-type');
const {JavaType, CEIType, TypeArgument, UnresolvedType} = require('java-mti')

/**
 * @param {JavaType} type 
 */
function checkType(type, is_return_type, typeTokens, probs) {
    if (type instanceof UnresolvedType) {
        return;
    }
    const typesig = type.typeSignature;
    if (typesig === 'V' && !is_return_type) {
        probs.push(ParseProblem.Error(typeTokens, `'void' is not a valid type for variables`))
    }
    if (/^\[+V/.test(typesig)) {
        probs.push(ParseProblem.Error(typeTokens, `Illegal type: '${type.label}'`))
    }
}

/**
 * @param {SourceType} type 
 * @param {*} probs 
 */
function checkInvalidTypes(type, probs) {
    type.fields.forEach(f => checkType(f.type, false, f._decl.typeTokens, probs));
    type.methods.forEach(m => {
        checkType(m.returnType, true, m._decl.typeTokens, probs);
        m.parameters.forEach(p => {
            checkType(p.type, false, p._decl.typeTokens, probs);
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
      
    source_types.forEach(type => checkInvalidTypes(type, probs));
      
    return probs;
}
