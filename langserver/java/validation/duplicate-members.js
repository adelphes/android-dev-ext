const { ModuleBlock, FieldBlock, TypeDeclBlock } = require('../parser9');
const ParseProblem = require('../parsetypes/parse-problem');

/**
 * 
 * @param {TypeDeclBlock} type 
 * @param {ParseProblem[]} probs 
 */
function checkDuplicateFieldName(type, probs) {
    /** @type {Map<string,FieldBlock>} */
    let names = new Map();
    type.fields.forEach(field => {
        if (!field.name) {
            return;
        }
        const value = names.get(field.name);
        if (value === undefined) {
            names.set(field.name, field);
        } else {
            if (value !== null) {
                probs.push(ParseProblem.Error(value, `Duplicate field: ${field.name}`));
                names.set(field.name, null);
            }
            probs.push(ParseProblem.Error(field, `Duplicate field: ${field.name}`));
        }
    })
    // check enclosed types
    type.types.forEach(type => checkDuplicateFieldName(type, probs));
}

/**
 * @param {string} outername
 * @param {TypeDeclBlock[]} types
 * @param {ParseProblem[]} probs 
 */
function checkDuplicateTypeNames(outername, types, probs) {
    /** @type {Map<string,TypeDeclBlock>} */
    let names = new Map();
    types.forEach(type => {
        const name = type.simpleName;
        if (!name) {
            return;
        }
        const value = names.get(name);
        if (value === undefined) {
            names.set(name, type);
        } else {
            if (value !== null) {
                probs.push(ParseProblem.Error(value.name_token, `Duplicate type: ${outername}${name}`));
                names.set(name, null);
            }
            probs.push(ParseProblem.Error(type.name_token, `Duplicate type: ${outername}${name}`));
        }
    })
    // check enclosed types
    types.forEach(type => {
        checkDuplicateTypeNames(`${outername}${type.simpleName}.`, type.types, probs);
    });
}

/**
 * @param {TypeDeclBlock} type 
 * @param {ParseProblem[]} probs 
 */
function checkDuplicateTypeVariableName(type, probs) {
    type.typevars.forEach((tv, i) => {
        const name = tv.name;
        if (tv.name === '?') {
            return;
        }
        if (type.typevars.findIndex(tv => tv.name === name) < i) {
            probs.push(ParseProblem.Error(tv.decl, `Duplicate type variable: ${name}`));
        }
    })
    // check enclosed types
    type.types.forEach(type => {
        checkDuplicateTypeVariableName(type, probs);
    });
}

/**
 * @param {ModuleBlock} mod 
 */
module.exports = function(mod) {
    const probs = [];
    mod.types.forEach(type => {
        checkDuplicateFieldName(type, probs);
        checkDuplicateTypeVariableName(type, probs);
    });
    checkDuplicateTypeNames('', mod.types, probs);
    return probs;
}

