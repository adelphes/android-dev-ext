const { ModuleBlock } = require('../parser9');
const ParseProblem = require('../parsetypes/parse-problem');
const {SourceType} = require('../source-type');
const { UnresolvedType } = require('java-mti');

/**
 * @param {SourceType} source_type 
 * @param {*} probs 
 */
function checkImplements(source_type, probs) {
    if (source_type.implements_types.length === 0) {
        return;
    }
    const interfaces = source_type.implements_types.map(it => it.resolved);
    if (source_type.typeKind === 'interface') {
        probs.push(ParseProblem.Error(source_type.implements_types[0].typeTokens, `Interface types cannot declare an implements section`));
    }
    if (source_type.typeKind === 'class') {
        interfaces.forEach((intf, i) => {
            if (intf instanceof UnresolvedType) {
                return;
            }
            if (intf.typeKind !== 'interface') {
                probs.push(ParseProblem.Error(source_type.implements_types[i].typeTokens, `Class '${source_type.fullyDottedRawName}' cannot implement ${intf.typeKind} type: '${intf.fullyDottedRawName}'`));
            }
        })
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
      
    source_types.forEach(type => checkImplements(type, probs));
      
    return probs;
}
