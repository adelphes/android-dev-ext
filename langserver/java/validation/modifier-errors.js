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
 * @param {TypeDeclBlock} type
 * @param {Map<string,*>} ownertypemods
 * @param {MethodBlock} method 
 * @param {ParseProblem[]} probs 
 */
function checkMethodModifiers(type, ownertypemods, method, probs) {
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
    if (type.kind() !== 'interface' && !allmods.has('abstract') && !allmods.has('native') && !method.body().simplified.startsWith('B')) {
        probs.push(ParseProblem.Error(method, `Method '${method.name}' must have an implementation or be defined as abstract or native`));
    }
    if (type.kind() !== 'interface' && allmods.has('abstract') && !ownertypemods.has('abstract')) {
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
    const typemods = new Map(type.modifiers.map(m => [m.source, m]));
    checkDuplicate(type.modifiers, probs);

    if (type.kind() === 'interface' && typemods.has('final')) {
        probs.push(ParseProblem.Error(typemods.get('final'), 'Interface declarations cannot be marked as final'));
    }
    if (type.kind() === 'enum' && typemods.has('abstract')) {
        probs.push(ParseProblem.Error(typemods.get('abstract'), 'Enum declarations cannot be marked as abstract'));
    }
    // top-level types cannot be private, protected or static
    for (let mod of ['private','protected', 'static']) {
        if (!type.outer_type && typemods.has(mod)) {
            probs.push(ParseProblem.Error(typemods.get(mod), `Top-level declarations cannot be marked as ${mod}`));
        }
    }
    if (type.outer_type) {
        checkConflictingAccess(type.modifiers, probs);
    }

    type.fields.forEach(field => checkFieldModifiers(field, probs));
    type.methods.forEach(method => checkMethodModifiers(type, typemods, method, probs));
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
