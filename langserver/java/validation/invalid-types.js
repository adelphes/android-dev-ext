const { SourceType, SourceTypeIdent } = require('../source-type');
const ParseProblem = require('../parsetypes/parse-problem');

/**
 * @param {SourceTypeIdent} type 
 * @param {boolean} is_return_type
 * @param {ParseProblem[]} probs
 */
function checkType(type, is_return_type, probs) {
    const typesig = type.resolved.typeSignature;
    if (/^\[*U/.test(typesig)) {
        probs.push(ParseProblem.Error(type.tokens, `Unresolved type '${type.resolved.label}'`))
        return;
    }
    if (typesig === 'V' && !is_return_type) {
        probs.push(ParseProblem.Error(type.tokens, `'void' is not a valid type for variables`))
    }
    if (/^\[+V/.test(typesig)) {
        probs.push(ParseProblem.Error(type.tokens, `Illegal type: '${type.resolved.label}'`))
    }
}

/**
 * @param {SourceType} type 
 * @param {*} probs 
 */
function checkInvalidTypes(type, probs) {
    type.fields.forEach(f => checkType(f.fieldTypeIdent, false, probs));
    type.methods.forEach(m => {
        checkType(m.returnTypeIdent, true, probs);
        m.parameters.forEach(p => {
            checkType(p.paramTypeIdent, false, probs);
        })
    })
    type.constructors.forEach(c => {
        c.parameters.forEach(p => {
            checkType(p.paramTypeIdent, false, probs);
        })
    })
}


/**
 * @param {SourceType[]} source_types
 */
module.exports = function(source_types) {
    /** @type {ParseProblem[]} */
    const probs = [];
      
    source_types.forEach(type => checkInvalidTypes(type, probs));
      
    return probs;
}
