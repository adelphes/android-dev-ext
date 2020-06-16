const { SourceType } = require('../source-type');
const ParseProblem = require('../parsetypes/parse-problem');
const { AnyType } = require('../body-types');

/**
 * @param {SourceType} source_type 
 * @param {*} probs 
 */
function checkExtends(source_type, probs) {
    const supertypes = source_type.extends_types
        .map(st => st.resolved)
        .filter(t => !(t instanceof AnyType));

    if (supertypes.length === 0) {
        return;
    }
    const supertype = supertypes[0];
    if (source_type.typeKind === 'enum') {
        probs.push(ParseProblem.Error(source_type.extends_types[0].tokens, `Enum types cannot declare a superclass`));
    }
    if (source_type.typeKind === 'class' && supertypes.length > 1) {
        probs.push(ParseProblem.Error(source_type.extends_types[1].tokens, `Class types cannot inherit from more than one type`));
    }
    if (source_type.typeKind === 'class' && supertype.typeKind !== 'class') {
        probs.push(ParseProblem.Error(source_type.extends_types[0].tokens, `Class '${source_type.fullyDottedRawName}' cannot inherit from ${supertype.typeKind} type: '${supertype.fullyDottedRawName}'`));
    }
    if (source_type.typeKind === 'class' && supertype.typeKind === 'class' && supertype.modifiers.includes('final')) {
        probs.push(ParseProblem.Error(source_type.extends_types[0].tokens, `Class '${source_type.fullyDottedRawName}' cannot inherit from final class: '${supertype.fullyDottedRawName}'`));
    }
    if (source_type.typeKind === 'class' && supertype === source_type) {
        probs.push(ParseProblem.Error(source_type.extends_types[0].tokens, `Class '${source_type.fullyDottedRawName}' cannot inherit from itself`));
    }
    if (source_type.typeKind === 'interface') {
        supertypes.forEach((supertype, i) => {
            if (supertype.typeKind !== 'interface') {
                probs.push(ParseProblem.Error(source_type.extends_types[i].tokens, `Interface '${source_type.fullyDottedRawName}' cannot inherit from ${supertype.typeKind} type: '${supertype.fullyDottedRawName}'`));
            }
            if (supertype === source_type) {
                probs.push(ParseProblem.Error(source_type.extends_types[i].tokens, `Interface '${source_type.fullyDottedRawName}' cannot inherit from itself`));
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
      
    source_types.forEach(type => checkExtends(type, probs));
      
    return probs;
}
