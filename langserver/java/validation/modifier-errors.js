const { SourceType, SourceMethod, SourceField, SourceConstructor, SourceInitialiser } = require('../source-type');
const { Token } = require('../tokenizer');
const ParseProblem = require('../parsetypes/parse-problem');

/**
 * @param {Token[]} mods 
 * @param {ParseProblem[]} probs 
 */
function checkDuplicate(mods, probs) {
    if (mods.length <= 1) {
        return;
    }
    const m = new Map();
    for (let mod of mods) {
        const firstmod = m.get(mod.source);
        if (firstmod === undefined) {
            m.set(mod.source, mod);
        } else {
            probs.push(ParseProblem.Error(mod, 'Duplicate modifier'));
        }
    }
}

/**
 * @param {Token[]} mods 
 * @param {ParseProblem[]} probs 
 */
function checkConflictingAccess(mods, probs) {
    if (mods.length <= 1) {
        return;
    }
    const allmods = mods.map(m => m.source).join(' ');
    for (let mod of mods) {
        let match;
        switch (mod.source) {
            case 'private':
                match = allmods.match(/protected|public/);
                break;
            case 'protected':
                match = allmods.match(/private|public/);
                break;
            case 'public':
                match = allmods.match(/private|protected/);
                break;
        }
        if (match) {
            probs.push(ParseProblem.Error(mod, `Access modifier '${mod.source}' conflicts with '${match[0]}'`));
        }
    }
}

/**
 * @param {SourceField} field 
 * @param {ParseProblem[]} probs 
 */
function checkFieldModifiers(field, probs) {
    checkDuplicate(field.modifierTokens, probs);
    checkConflictingAccess(field.modifierTokens, probs);
    for (let mod of field.modifierTokens) {
        switch (mod.source) {
            case 'abstract':
                probs.push(ParseProblem.Error(mod, 'Field declarations cannot be abstract'));
                break;
            case 'native':
                probs.push(ParseProblem.Error(mod, 'Field declarations cannot be native'));
                break;
        }
    }
}

/**
 * @param {SourceType} type
 * @param {Map<string,*>} ownertypemods
 * @param {SourceMethod} method 
 * @param {ParseProblem[]} probs 
 */
function checkMethodModifiers(type, ownertypemods, method, probs) {
    checkDuplicate(method.modifierTokens, probs);
    checkConflictingAccess(method.modifierTokens, probs);

    const allmods = new Map(method.modifierTokens.map(m => [m.source, m]));
    const is_interface_kind = /@?interface/.test(type.typeKind);
    const has_body = method.hasImplementation;

    if (allmods.has('abstract') && allmods.has('final')) {
        probs.push(ParseProblem.Error(allmods.get('abstract'), 'Method declarations cannot be abstract and final'));
    }
    if (allmods.has('abstract') && allmods.has('native')) {
        probs.push(ParseProblem.Error(allmods.get('abstract'), 'Method declarations cannot be abstract and native'));
    }
    if (allmods.has('abstract') && has_body) {
        probs.push(ParseProblem.Error(allmods.get('abstract'), 'Method declarations marked as abstract cannot have a method body'));
    }
    if (!is_interface_kind && !allmods.has('abstract') && !allmods.has('native') && !has_body) {
        probs.push(ParseProblem.Error(method.nameToken, `Method '${method.name}' must have an implementation or be defined as abstract or native`));
    }
    if (!is_interface_kind && allmods.has('abstract') && !ownertypemods.has('abstract')) {
        probs.push(ParseProblem.Error(allmods.get('abstract'), `Method '${method.name}' cannot be declared abstract inside a non-abstract type`));
    }
    if (is_interface_kind && has_body && !allmods.has('default')) {
        probs.push(ParseProblem.Error(method.body[0], `Non-default interface methods cannot have a method body`));
    }
    if (allmods.has('native') && has_body) {
        probs.push(ParseProblem.Error(allmods.get('native'), 'Method declarations marked as native cannot have a method body'));
    }
    // JLS8
    if (type.typeKind !== 'interface' && allmods.has('default')) {
        probs.push(ParseProblem.Error(allmods.get('default'), `Default method declarations are only allowed inside interfaces`));
    }
    if (allmods.has('default') && !has_body) {
        probs.push(ParseProblem.Error(allmods.get('default'), `Default method declarations must have an implementation`));
    }
}

/**
 * @param {SourceConstructor} field 
 * @param {ParseProblem[]} probs 
 */
function checkConstructorModifiers(field, probs) {
}

/**
 * @param {SourceInitialiser} initialiser 
 * @param {ParseProblem[]} probs 
 */
function checkInitialiserModifiers(initialiser, probs) {
}

/**
 * @param {SourceType} type 
 * @param {ParseProblem[]} probs 
 */
function checkTypeModifiers(type, probs) {
    const typemods = new Map(type.modifierTokens.map(m => [m.source, m]));
    checkDuplicate(type.modifierTokens, probs);

    if (type.typeKind === 'interface' && typemods.has('final')) {
        probs.push(ParseProblem.Error(typemods.get('final'), 'Interface declarations cannot be marked as final'));
    }
    if (type.typeKind === 'enum' && typemods.has('abstract')) {
        probs.push(ParseProblem.Error(typemods.get('abstract'), 'Enum declarations cannot be marked as abstract'));
    }
    if (/[$]/.test(type._rawShortSignature)) {
        checkConflictingAccess(type.modifierTokens, probs);
    } else {
        // top-level types cannot be private, protected or static
        for (let mod of ['private','protected', 'static']) {
            if (typemods.has(mod)) {
                probs.push(ParseProblem.Error(typemods.get(mod), `Top-level declarations cannot be marked as ${mod}`));
            }
        }
    }

    type.fields.forEach(field => checkFieldModifiers(field, probs));
    type.methods.forEach(method => checkMethodModifiers(type, typemods, method, probs));
    type.constructors.forEach(ctr => checkConstructorModifiers(ctr, probs));
    type.initers.forEach(initer => checkInitialiserModifiers(initer, probs));
}

/**
 * @param {SourceType[]} types 
 */
module.exports = function(types) {
    const probs = [];
    types.forEach(type => checkTypeModifiers(type, probs));
    return probs;
}
