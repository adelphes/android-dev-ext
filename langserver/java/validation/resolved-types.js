/**
 * @typedef {import('../parsetypes/resolved-import')} ResolvedImport
 */
const { ModuleBlock, TypeDeclBlock, DeclaredVariableBlock, MethodBlock, ParameterBlock, TextBlock } = require('../parser9');
const ParseProblem = require('../parsetypes/parse-problem');
const { resolveTypes } = require('../type-resolver');
const ResolvedType = require('../parsetypes/resolved-type');

/**
 * @param {DeclaredVariableBlock|MethodBlock|TextBlock[] & {typeTokens: *[]}} decl
 * @param {ResolvedType|ResolvedType[]} resolved 
 * @param {ParseProblem[]} probs 
 */
function checkResolvedTypes(decl, resolved, probs) {
    if (Array.isArray(resolved)) {
        resolved.forEach(resolved => checkResolvedTypes(decl, resolved, probs));
        return;
    }
    if (resolved.error) {
        probs.push(ParseProblem.Error(decl, resolved.error));
        return;
    }
    // the parser will detect varargs (...) on all variable declarations
    if (decl instanceof DeclaredVariableBlock && decl.isVarArgs && !(decl instanceof ParameterBlock)) {
        probs.push(ParseProblem.Error(decl.varBlock.varargs_token, `Variable-arity can only be applied to parameter declarations.`));
    }
    // void arrays are illegal
    if (/^void\[/.test(resolved.rawlabel)) {
        probs.push(ParseProblem.Error(decl.typeTokens, `Invalid type: ${resolved.rawlabel}`));
        return;
    }
    // void can only be used for method declarations
    if (resolved.rawlabel === 'void' && decl instanceof DeclaredVariableBlock) {
        probs.push(ParseProblem.Error(decl.typeTokens, `'void' is not a valid type for fields, parameters or variables`));
        return;
    }
    // no primitive type arguments
    if (resolved.isTypeArg && resolved.isPrimitive) {
        probs.push(ParseProblem.Error(decl.typeTokens, `Primitive types cannot be used as type arguments.`));
        return;
    }
    switch (resolved.mtis.length) {
        case 0: 
            probs.push(ParseProblem.Error(decl.typeTokens, `Unresolved type: '${resolved.rawlabel}'`));
            break;
        case 1: 
            break;
        default:
            const matchlist = resolved.mtis.map(m => `'${m.fullyDottedRawName}'`).join(', ');
            probs.push(ParseProblem.Error(decl.typeTokens, `Ambiguous type: '${resolved.rawlabel}'. Possible matches: ${matchlist}.`));
            break;
    }

    // check type arguments
    resolved.parts
        .filter(typepart => typepart.typeargs)
        .forEach(typepart => {
            checkResolvedTypes(decl, typepart.typeargs, probs);
            // check number of type arguments match
            if (resolved.mtis.length === 1 && typepart.typeargs.length !== resolved.mtis[0].typevars.length) {
                const msg = resolved.mtis[0].typevars.length === 0
                    ? `Type '${resolved.mtis[0].fullyDottedRawName}' is not declared as a parameterized type and cannot be used with type arguments.`
                    : `Wrong number of type arguments for: '${resolved.mtis[0].fullyDottedRawName}'. Expected ${resolved.mtis[0].typevars.length} but found ${typepart.typeargs.length}.`;
                probs.push(ParseProblem.Error(decl.typeTokens, msg));
            }
        });
}

/**
 * @param {string} outername
 * @param {TypeDeclBlock} owner_type
 * @param {''|'.'|'$'} qualifier
 * @param {ResolvedImport[]} resolved_imports
 * @param {Map<string, import('../mti').Type>} typemap
 * @param {ParseProblem[]} probs 
 */
function resolveFieldTypes(outername, owner_type, qualifier, resolved_imports, typemap, probs) {
    const fieldtypes = owner_type.fields.map(f => f.type);
    const fully_qualified_scope_name = `${outername}${qualifier}${owner_type.simpleName}`;
    const resolved = resolveTypes(fieldtypes, fully_qualified_scope_name, resolved_imports, typemap);
    owner_type.fields.forEach((field,i) => {
        checkResolvedTypes(field, resolved[i], probs);
    })
    // check enclosed types
    owner_type.types.forEach(type => {
        resolveFieldTypes(fully_qualified_scope_name, type, '$', resolved_imports, typemap, probs);
    });
}

function extractTypeList(decl) {
    if (!decl) {
        return [];
    }
    const types = [];
    const re = /[WD]( *[WDT.])*/g;
    decl = decl.blockArray();
    const sm = decl.sourcemap();
    for (let m; m  = re.exec(sm.simplified);) {
        const start = sm.map[m.index], end = sm.map[m.index + m[0].length-1];
        const block_range = decl.blocks.slice(start, end+1);
        const typename = block_range.map(b => b.source).join('');
        block_range.typename = typename;
        block_range.typeTokens = block_range;
        types.push(block_range);
    }
    return types; 
}

/**
 * @param {string} outername
 * @param {TypeDeclBlock} owner_type
 * @param {''|'.'|'$'} qualifier
 * @param {ResolvedImport[]} resolved_imports
 * @param {Map<string, import('../mti').Type>} typemap
 * @param {ParseProblem[]} probs 
 */
function resolveExtends(outername, owner_type, qualifier, resolved_imports, typemap, probs) {
    if (!owner_type.extends_token) {
        return;
    }
    // the scope for extends and implements needs to include any type variables, but not enclosed types
    const fully_qualified_scope_name = `${outername}${qualifier}${owner_type.simpleName}`;
    if (!/^(class|interface)/.test(owner_type.kind())) {
        probs.push(ParseProblem.Error(owner_type.extends_token, `extends declaration is not valid for ${owner_type.kind()} type: ${fully_qualified_scope_name}`));
        return;
    }
    const eit_types = extractTypeList(owner_type.extends_token);
    const resolved = resolveTypes(eit_types.map(x => x.typename), fully_qualified_scope_name, resolved_imports, typemap);
    eit_types.forEach((eit_type,i) => {
        checkResolvedTypes(eit_type, resolved[i], probs);
    })
    switch(owner_type.kind()) {
        case 'class':
            if (eit_types[0] && resolved[0].mtis.length === 1 && resolved[0].mtis[0].typeKind !== 'class') {
                probs.push(ParseProblem.Error(eit_types[0], `Class '${fully_qualified_scope_name}' cannot extend from ${resolved[0].mtis[0].typeKind} type '${resolved[0].mtis[0].fullyDottedRawName}'`));
            }
            if (eit_types.length > 1) {
                probs.push(ParseProblem.Error(eit_types[1], `Class types cannot extend from more than one type`));
            }
            break;
        case "interface":
            eit_types.forEach((eit_type, i) => {
                const mti = resolved[i].mtis[0];
                if (resolved[i].mtis.length === 1 && mti.typeKind !== 'interface') {
                    probs.push(ParseProblem.Error(eit_type, `Interface '${fully_qualified_scope_name}' cannot extend from ${mti.typeKind} type '${mti.fullyDottedRawName}'`));
                }
                // check for repeated types
                if (resolved[i].mtis.length === 1) {
                    const name = resolved[i].mtis[0].fullyDottedRawName;
                    if (resolved.findIndex(r => r.mtis.length === 1 && r.mtis[0].fullyDottedRawName === name) < i) {
                        probs.push(ParseProblem.Error(eit_types[1], `Repeated type: ${name}`));
                    }
                }
            })
            break;
    }
    // check enclosed types
    owner_type.types.forEach(type => {
        resolveExtends(fully_qualified_scope_name, type, '$', resolved_imports, typemap, probs);
    });
}

/**
 * @param {string} outername
 * @param {TypeDeclBlock} owner_type
 * @param {''|'.'|'$'} qualifier
 * @param {ResolvedImport[]} resolved_imports
 * @param {Map<string, import('../mti').Type>} typemap
 * @param {ParseProblem[]} probs 
 */
function resolveImplements(outername, owner_type, qualifier, resolved_imports, typemap, probs) {
    if (!owner_type.implements_token) {
        return;
    }
    const fully_qualified_scope_name = `${outername}${qualifier}${owner_type.simpleName}`;
    if (!/class/.test(owner_type.kind())) {
        probs.push(ParseProblem.Error(owner_type.implements_token, `implements declaration is not valid for ${owner_type.kind()} type: ${fully_qualified_scope_name}`));
        return;
    }
    const eit_types = extractTypeList(owner_type.implements_token);
    // the scope for extends and implements needs to include any type variables, but not enclosed types
    const resolved = resolveTypes(eit_types.map(x => x.typename), fully_qualified_scope_name, resolved_imports, typemap);
    eit_types.forEach((eit_type,i) => {
        checkResolvedTypes(eit_type, resolved[i], probs);
    })
    eit_types.forEach((eit_type, i) => {
        const mti = resolved[i].mtis[0];
        if (resolved[i].mtis.length === 1 && mti.typeKind !== 'interface') {
            probs.push(ParseProblem.Error(eit_type, `Interface '${fully_qualified_scope_name}' cannot extend from ${mti.typeKind} type '${mti.fullyDottedRawName}'`));
        }
        // check for repeated types
        if (resolved[i].mtis.length === 1) {
            const name = resolved[i].mtis[0].fullyDottedRawName;
            if (resolved.findIndex(r => r.mtis.length === 1 && r.mtis[0].fullyDottedRawName === name) < i) {
                probs.push(ParseProblem.Error(eit_types[1], `Repeated type: ${name}`));
            }
        }
    })
    // check enclosed types
    owner_type.types.forEach(type => {
        resolveImplements(fully_qualified_scope_name, type, '$', resolved_imports, typemap, probs);
    });
}

/**
 * @param {string} outername
 * @param {TypeDeclBlock} owner_type
 * @param {''|'.'|'$'} qualifier
 * @param {ResolvedImport[]} resolved_imports
 * @param {Map<string, import('../mti').Type>} typemap
 * @param {ParseProblem[]} probs 
 */
function resolveMethodTypes(outername, owner_type, qualifier, resolved_imports, typemap, probs) {
    const method_type_names = [];
    owner_type.methods.forEach(m => {
        method_type_names.push(m.type);
        m.parameters.forEach(p => {
            method_type_names.push(p.type);
        });
    });
    const fully_qualified_scope_name = `${outername}${qualifier}${owner_type.simpleName}`;
    const resolved = resolveTypes(method_type_names, fully_qualified_scope_name, resolved_imports, typemap);
    let i = 0;
    owner_type.methods.forEach(method => {
        checkResolvedTypes(method, resolved[i++], probs);
        method.parameters.forEach((parameter, idx, arr) => {
            checkResolvedTypes(parameter, resolved[i++], probs);
            if (parameter.isVarArgs && idx !== arr.length-1) {
                probs.push(ParseProblem.Error(parameter, `Variable-arity parameters must be declared last.`));
            }
        });
    })
    // check enclosed types
    owner_type.types.forEach(type => {
        resolveMethodTypes(fully_qualified_scope_name, type, '$', resolved_imports, typemap, probs);
    });
}

/**
 * @param {ModuleBlock} mod 
 */
module.exports = function(mod, imports) {
    /** @type {ParseProblem[]} */
    const probs = [];

    mod.types.forEach(type => {
        const qualifier = mod.packageName ? '.' : '';
        resolveExtends(mod.packageName, type, qualifier, imports.resolved, imports.typemap, probs);
        resolveImplements(mod.packageName, type, qualifier, imports.resolved, imports.typemap, probs);
        resolveFieldTypes(mod.packageName, type, qualifier, imports.resolved, imports.typemap, probs);
        resolveMethodTypes(mod.packageName, type, qualifier, imports.resolved, imports.typemap, probs);
    });

    return probs;
}
