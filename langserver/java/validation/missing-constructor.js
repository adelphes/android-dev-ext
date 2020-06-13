const { ModuleBlock, TypeDeclBlock } = require('../parser9');
const ParseProblem = require('../parsetypes/parse-problem');
const {SourceType, SourceConstructor} = require('../source-type');

/**
 * @param {SourceType} source_type 
 * @param {ParseProblem[]} probs 
 */
function checkConstructor(source_type, probs) {
    if (source_type.typeKind !== 'class') {
        return;
    }
    if (source_type.constructors[0] instanceof SourceConstructor) {
        return;
    }
    const superclass = source_type.supers.find(s => s.typeKind === 'class');
    if (!superclass) {
        // if there's no superclass, the class must inherit from an interface
        // - which means the inherited class is Object (and a default constructor exists)
        return;
    }
    if (!superclass.constructors.find(c => c.parameterCount === 0)) {
        // the source type has no declared constructors, but the superclass
        // does not include a default (parameterless) constructor
        probs.push(ParseProblem.Error(source_type.name_token, `Class '${source_type.fullyDottedRawName}' requires a constructor to be declared because the inherited class '${superclass.fullyDottedRawName}' does not define a default constructor.`));
    }
}

/**
 * @param {ModuleBlock} mod 
 * @param {*} imports
 * @param {SourceType[]} source_types
 */
module.exports = function(mod, imports, source_types) {
    /** @type {ParseProblem[]} */
    const probs = [];
      
    source_types.forEach(type => checkConstructor(type, probs));
      
    return probs;
}
