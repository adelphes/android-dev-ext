const { TextBlock, ModuleBlock, FieldBlock, MethodBlock, ConstructorBlock, InitialiserBlock, TypeDeclBlock } = require('../parser9');
const ParseProblem = require('../parsetypes/parse-problem');

/**
 * @param {TextBlock[]} mods 
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
            if (firstmod !== null) {
                probs.push(ParseProblem.Error(firstmod, 'Duplicate modifier'));
                m.set(mod.source, null);
            }
        }
    }
}

/**
 * @param {TextBlock[]} mods 
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
 * @param {FieldBlock} field 
 * @param {ParseProblem[]} probs 
 */
function checkFieldModifiers(field, probs) {
    checkDuplicate(field.modifiers, probs);
    checkConflictingAccess(field.modifiers, probs);
    for (let mod of field.modifiers) {
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
 * @param {Set<string>} ownertypemods
 * @param {MethodBlock} method 
 * @param {ParseProblem[]} probs 
 */
function checkMethodModifiers(ownertypemods, method, probs) {
    checkDuplicate(method.modifiers, probs);
    checkConflictingAccess(method.modifiers, probs);
    const allmods = new Map(method.modifiers.map(m => [m.source, m]));
    if (allmods.has('abstract') && allmods.has('final')) {
        probs.push(ParseProblem.Error(allmods.get('abstract'), 'Method declarations cannot be abstract and final'));
    }
    if (allmods.has('abstract') && allmods.has('native')) {
        probs.push(ParseProblem.Error(allmods.get('abstract'), 'Method declarations cannot be abstract and native'));
    }
    if (allmods.has('abstract') && method.body().simplified.startsWith('B')) {
        probs.push(ParseProblem.Error(allmods.get('abstract'), 'Method declarations marked as abstract cannot have a method body'));
    }
    if (!allmods.has('abstract') && !allmods.has('native') && !method.body().simplified.startsWith('B')) {
        probs.push(ParseProblem.Error(method, `Method '${method.name}' must have an implementation or be defined as abstract or native`));
    }
    if (allmods.has('abstract') && !ownertypemods.has('abstract')) {
        probs.push(ParseProblem.Error(method, `Method '${method.name}' cannot be declared abstract inside a non-abstract type`));
    }
    if (allmods.has('native') && method.body().simplified.startsWith('B')) {
        probs.push(ParseProblem.Error(allmods.get('native'), 'Method declarations marked as native cannot have a method body'));
    }
}

/**
 * @param {ConstructorBlock} field 
 * @param {ParseProblem[]} probs 
 */
function checkConstructorModifiers(field, probs) {
}

/**
 * @param {InitialiserBlock} initialiser 
 * @param {ParseProblem[]} probs 
 */
function checkInitialiserModifiers(initialiser, probs) {
}

/**
 * @param {TypeDeclBlock} type 
 * @param {ParseProblem[]} probs 
 */
function checkTypeModifiers(type, probs) {
    const typemods = new Set(type.modifiers.map(m => m.source));
    type.fields.forEach(field => checkFieldModifiers(field, probs));
    type.methods.forEach(method => checkMethodModifiers(typemods, method, probs));
    type.constructors.forEach(ctr => checkConstructorModifiers(ctr, probs));
    //type.initialisers.forEach(initer => checkInitModifiers(initer, probs));
    // check enclosed types
    type.types.forEach(type => checkTypeModifiers(type, probs));
}

/**
 * @param {ModuleBlock} mod 
 */
module.exports = function(mod) {
    const probs = [];
    mod.types.forEach(type => checkTypeModifiers(type, probs));
    return probs;
}
