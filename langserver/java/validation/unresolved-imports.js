const { ModuleBlock } = require('../parser9');
const ParseProblem = require('../parsetypes/parse-problem');

/**
 * @param {ModuleBlock} mod 
 */
module.exports = function(mod, imports) {
    /** @type {ParseProblem[]} */
    const probs = [];
      
    imports.unresolved.forEach(i => {
        probs.push(ParseProblem.Warning(i, `Unresolved import: ${i.name}`));
    })
      
    return probs;
}
