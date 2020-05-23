const { ModuleBlock } = require('./../parser9');
const ParseProblem = require('./../parsetypes/parse-problem');

/**
 * @param {ModuleBlock} mod 
 */
module.exports = function(mod) {
    return mod.packages.slice(1).map(
        pkg => {
            return ParseProblem.Error(pkg, 'Additional package declaration');
        }
    )
}