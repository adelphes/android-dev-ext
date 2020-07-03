const { SourceUnit } = require('../source-types');
const ParseProblem = require('../parsetypes/parse-problem');

/**
 * @param {SourceUnit} unit
 */
module.exports = function(mod, unit) {
    /** @type {ParseProblem[]} */
    const probs = [];
      
    unit.imports.forEach(i => {
        if (!i.resolved)
            probs.push(ParseProblem.Warning(i.nameTokens, `Unresolved import: ${i.package_name}`));
    })
      
    return probs;
}
