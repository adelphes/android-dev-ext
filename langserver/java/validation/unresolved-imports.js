const { ModuleBlock } = require('../parser9');
const ParseProblem = require('../parsetypes/parse-problem');

/**
 * @param {ModuleBlock} mod 
 * @param {{unresolved:*[]}} imports
 */
module.exports = function(mod, imports) {
    /** @type {ParseProblem[]} */
    const probs = [];
      
    imports.unresolved.forEach(import_tokens => {
        probs.push(ParseProblem.Warning(import_tokens, `Unresolved import: ${import_tokens.name}`));
    })
      
    return probs;
}
