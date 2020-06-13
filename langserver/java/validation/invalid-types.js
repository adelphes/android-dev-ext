const { ModuleBlock } = require('../parser9');
const ParseProblem = require('../parsetypes/parse-problem');
const {SourceType} = require('../source-type');
const {Token} = require('../tokenizer');
const {JavaType} = require('java-mti');

/**
 * @param {JavaType} type 
 * @param {boolean} is_return_type
 * @param {Token[]} typeTokens
 * @param {ParseProblem[]} probs
 */
function checkType(type, is_return_type, typeTokens, probs) {
    const typesig = type.typeSignature;
    if (/^\[*U/.test(typesig)) {
        probs.push(ParseProblem.Error(typeTokens, `Unresolved type '${type.label}'`))
        return;
    }
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
    type.fields.forEach(f => checkType(f.type, false, f.fieldType.typeTokens, probs));
    type.methods.forEach(m => {
        checkType(m.returnType, true, m.methodTypeIdent.typeTokens, probs);
        m.parameters.forEach(p => {
            checkType(p.type, false, p.paramTypeIdent.typeTokens, probs);
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
