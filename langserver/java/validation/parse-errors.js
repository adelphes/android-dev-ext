const { ModuleBlock, TypeDeclBlock, MethodBlock } = require('../parser9');
const ParseProblem = require('../parsetypes/parse-problem');

/**
 * @param {TypeDeclBlock} type 
 * @param {ParseProblem[]} probs 
 */
function checkTypeParseErrors(type, probs) {
    type.parseErrors.forEach(err => probs.push(ParseProblem.Error(err, `Invalid, incomplete or unsupported declaration`)));
    type.methods.filter(m => m.parseErrors).forEach(m => checkMethodParseErrors(m, probs));
    type.types.forEach(type => checkTypeParseErrors(type, probs));
}

/**
 * @param {MethodBlock} method 
 * @param {ParseProblem[]} probs 
 */
function checkMethodParseErrors(method, probs) {
    method.parseErrors.forEach(err => probs.push(ParseProblem.Error(err, `Invalid, incomplete or unsupported declaration`)));
}

/**
 * @param {ModuleBlock} mod 
 */
module.exports = function(mod) {
    const probs = [];
    mod.types.forEach(type => checkTypeParseErrors(type, probs));
    return probs;
}
