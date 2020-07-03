const ParseProblem = require('../parsetypes/parse-problem');
const {SourceType} = require('../source-types');
const { AnyType } = require('../anys');
const { UnresolvedType } = require('java-mti');

/**
 * @param {SourceType} source_type 
 * @param {*} probs 
 */
function checkImplements(source_type, probs) {
    const superinterfaces = source_type.implements_types
        .map(st => st.resolved)
        .filter(t => !(t instanceof AnyType));

    if (superinterfaces.length === 0) {
        return;
    }
    if (source_type.typeKind === 'interface') {
        probs.push(ParseProblem.Error(source_type.implements_types[0].tokens, `Interface types cannot declare an implements section`));
    }
    if (source_type.typeKind === 'class') {
        superinterfaces.forEach((intf, i) => {
            if (intf instanceof UnresolvedType) {
                return;
            }
            if (intf.typeKind !== 'interface') {
                probs.push(ParseProblem.Error(source_type.implements_types[i].tokens, `Class '${source_type.fullyDottedRawName}' cannot implement ${intf.typeKind} type: '${intf.fullyDottedRawName}'`));
            }
        })
    }
}

/**
 * @param {SourceType[]} source_types
 */
module.exports = function(source_types) {
    /** @type {ParseProblem[]} */
    const probs = [];
      
    source_types.forEach(type => checkImplements(type, probs));
      
    return probs;
}
