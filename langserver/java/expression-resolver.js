/**
 * @typedef {import('./tokenizer').Token} Token
 * @typedef {import('./anys').ResolvedValue} ResolvedValue
 * @typedef {import('./body-types').ResolvedIdent} ResolvedIdent
 */
const ParseProblem = require('./parsetypes/parse-problem');
const { TypeVariable, JavaType, PrimitiveType, NullType, ArrayType, CEIType, WildcardType, TypeVariableType, InferredTypeArgument } = require('java-mti');
const { AnyType, ArrayValueType, LambdaType, MultiValueType } = require('./anys');
const { ResolveInfo } = require('./body-types');
const { NumberLiteral } = require('./expressiontypes/literals/Number');

/**
 * @param {ResolveInfo} ri
 * @param {ResolvedIdent} expression 
 * @param {JavaType} assign_type 
 */
function checkAssignment(ri, assign_type, expression) {
    const value = expression.resolveExpression(ri);
    checkTypeAssignable(assign_type, value, () => expression.tokens, ri.problems);
}

/**
 * 
 * @param {JavaType} variable_type 
 * @param {ResolvedValue} value 
 * @param {() => Token|Token[]} tokens
 * @param {ParseProblem[]} problems
 */
function checkTypeAssignable(variable_type, value, tokens, problems) {
    if (value instanceof NumberLiteral) {
        if (!value.isCompatibleWith(variable_type)) {
            incompatibleTypesError(variable_type, value.type, () => value.tokens(), problems);
        }
        return;
    }
    if (value instanceof MultiValueType) {
        value.types.forEach(t => checkTypeAssignable(variable_type, t, tokens, problems));
        return;
    }
    if (value instanceof ArrayValueType) {
        checkArrayLiteral(variable_type, value, tokens, problems);
        return;
    }
    if (value instanceof LambdaType) {
        checkLambdaAssignable(variable_type, value, tokens, problems);
        return;
    }
    if (value instanceof JavaType) {
        if (!isTypeAssignable(variable_type, value)) {
            incompatibleTypesError(variable_type, value, tokens, problems);
        }
        return;
    }
    problems.push(ParseProblem.Error(tokens(), `Field, variable or method call expected`));
}

/**
 * 
 * @param {JavaType} variable_type 
 * @param {JavaType} value_type 
 * @param {() => Token|Token[]} tokens
 * @param {ParseProblem[]} problems
 */
function incompatibleTypesError(variable_type, value_type, tokens, problems) {
    problems.push(ParseProblem.Error(tokens(), `Incompatible types: Expression of type '${value_type.fullyDottedTypeName}' cannot be assigned to a variable of type '${variable_type.fullyDottedTypeName}'`));
}

/**
 * 
 * @param {JavaType} variable_type 
 * @param {LambdaType} value 
 * @param {() => Token|Token[]} tokens
 * @param {ParseProblem[]} problems
 */
function checkLambdaAssignable(variable_type, value, tokens, problems) {
    const res = isLambdaAssignable(variable_type, value);
    if (res === true) {
        return;
    }
    switch (res[0]) {
        case 'non-interface':
            problems.push(ParseProblem.Error(tokens(), `Incompatible types: Cannot assign lambda expression to type '${variable_type.fullyDottedTypeName}'`));
            return;
        case 'no-methods':
            problems.push(ParseProblem.Error(tokens(), `Incompatible types: Interface '${variable_type.fullyDottedTypeName}' contains no abstract methods compatible with the specified lambda expression`));
            return;
        case 'param-count':
            problems.push(ParseProblem.Error(tokens(), `Incompatible types: Interface method '${variable_type.methods[0].label}' and lambda expression have different parameter counts`));
            return;
        case 'bad-param':
            problems.push(ParseProblem.Error(tokens(), `Incompatible types: Interface method '${variable_type.methods[0].label}' and lambda expression have different parameter types`));
            return;
    }
}

/**
 * 
 * @param {JavaType} variable_type 
 * @param {LambdaType} value 
 */
function isLambdaAssignable(variable_type, value) {
    if (!(variable_type instanceof CEIType) || variable_type.typeKind !== 'interface') {
        return ['non-interface'];
    }
    // the functional interface must only contain one abstract method excluding public Object methods
    // and ignoring type-compatible methods from superinterfaces.
    // this is quite complicated to calculate, so for now, just check against the most common case: a simple interface type with
    // a single abstract method
    if (variable_type.supers.length > 1) {
        return true;
    }
    if (variable_type.methods.length === 0) {
        return ['no-methods']
    }
    if (variable_type.methods.length > 1) {
        return true;
    }
    const intf_method = variable_type.methods[0];
    const intf_params = intf_method.parameters;
    if (intf_params.length !== value.param_types.length) {
        return ['param-count'];
    }

    for (let i = 0; i < intf_params.length; i++) {
        // explicit parameter types must match exactly
        if (value.param_types[i] instanceof AnyType) {
            continue;
        }
        if (intf_params[i].type instanceof AnyType) {
            continue;
        }
        if (intf_params[i].type.typeSignature !== value.param_types[i].typeSignature) {
            return ['bad-param']
        }
    }

    return true;
}

/**
 * 
 * @param {JavaType} variable_type 
 * @param {ArrayValueType} value_type 
 * @param {() => Token|Token[]} tokens
 * @param {ParseProblem[]} problems
 */
function checkArrayLiteral(variable_type, value_type, tokens, problems) {
    if (!(variable_type instanceof ArrayType)) {
        problems.push(ParseProblem.Error(tokens(), `Array expression cannot be assigned to a variable of type '${variable_type.fullyDottedTypeName}'`));
        return;
    }
    if (value_type.elements.length === 0) {
        // empty arrays are compatible with all array types
        return;
    }
    const element_type = variable_type.elementType;
    value_type.elements.forEach(element => {
        checkArrayElement(element_type, element.value, element.tokens);
    });

    /**
     * @param {JavaType} element_type 
     * @param {ResolvedValue} value_type 
     * @param {Token[]} tokens
     */
    function checkArrayElement(element_type, value_type, tokens) {
        if (value_type instanceof NumberLiteral) {
            if (!value_type.isCompatibleWith(element_type)) {
                incompatibleTypesError(element_type, value_type.type, () => tokens, problems);
            }
            return;
        }
        if (value_type instanceof JavaType) {
            if (!isTypeAssignable(element_type, value_type)) {
                incompatibleTypesError(element_type, value_type, () => tokens, problems);
            }
            return;
        }
        if (value_type instanceof ArrayValueType) {
            checkArrayLiteral(element_type, value_type, () => tokens, problems);
            return;
        }
        problems.push(ParseProblem.Error(tokens, `Expression expected`));
    }
}

/**
 * @param {ResolveInfo} ri 
 * @param {ResolvedIdent} d 
 * @param {'index'|'dimension'} kind
 */
function checkArrayIndex(ri, d, kind) {
    const idx = d.resolveExpression(ri);
    if (idx instanceof NumberLiteral) {
        if (!idx.isCompatibleWith(PrimitiveType.map.I)) {
            ri.problems.push(ParseProblem.Error(d.tokens, `Value '${idx.toNumber()}' is not valid as an array ${kind}`));
        }
        else if (idx.toNumber() < 0) {
            ri.problems.push(ParseProblem.Error(d.tokens, `Negative array ${kind}: ${idx.toNumber()}`));
        }
        return;
    }
    if (idx instanceof PrimitiveType) {
        if (!/^[BSI]$/.test(idx.typeSignature)) {
            ri.problems.push(ParseProblem.Error(d.tokens, `Expression of type '${idx.label}' is not valid as an array ${kind}`));
        }
        return;
    }
    ri.problems.push(ParseProblem.Error(d.tokens, `Integer value expected`));
}

/**
 * Set of regexes to map source primitives to their destination types.
 * eg, long (J) is type-assignable to long, float and double (and their boxed counterparts)
 * Note that void (V) is never type-assignable to anything
 */
const valid_primitive_types = {
    // conversions from a primitive to a value
    from: {
        B: /^[BSIJFD]$|^Ljava\/lang\/(Byte|Short|Integer|Long|Float|Double);$/,
        S: /^[SIJFD]$|^Ljava\/lang\/(Short|Integer|Long|Float|Double);$/,
        I: /^[IJFD]$|^Ljava\/lang\/(Integer|Long|Float|Double);$/,
        J: /^[JFD]$|^Ljava\/lang\/(Long|Float|Double);$/,
        F: /^[FD]$|^Ljava\/lang\/(Float|Double);$/,
        D: /^D$|^Ljava\/lang\/(Double);$/,
        C: /^[CIJFD]$|^Ljava\/lang\/(Character|Integer|Long|Float|Double);$/,
        Z: /^Z$|^Ljava\/lang\/(Boolean);$/,
        V: /$^/,    // V.test() always returns false
    },
    // conversions to a primitive from a value
    to: {
        B: /^[B]$|^Ljava\/lang\/(Byte);$/,
        S: /^[BS]$|^Ljava\/lang\/(Byte|Short);$/,
        I: /^[BSIC]$|^Ljava\/lang\/(Byte|Short|Integer|Character);$/,
        J: /^[BSIJC]$|^Ljava\/lang\/(Byte|Short|Integer|Long|Character);$/,
        F: /^[BSIJCF]$|^Ljava\/lang\/(Byte|Short|Integer|Long|Character|Float);$/,
        D: /^[BSIJCFD]$|^Ljava\/lang\/(Byte|Short|Integer|Long|Character|Float|Double);$/,
        C: /^C$|^Ljava\/lang\/(Character);$/,
        Z: /^Z$|^Ljava\/lang\/(Boolean);$/,
        V: /$^/,    // V.test() always returns false
    }
}

/**
 * Returns true if a value of value_type is assignable to a variable of dest_type
 * @param {JavaType} dest_type 
 * @param {JavaType|NumberLiteral|LambdaType|MultiValueType} value_type 
 */
function isTypeAssignable(dest_type, value_type) {

    if (value_type instanceof NumberLiteral) {
        return value_type.isCompatibleWith(dest_type);
    }

    if (value_type instanceof LambdaType) {
        return isLambdaAssignable(dest_type, value_type) === true;
    }

    if (value_type instanceof MultiValueType) {
        return value_type.types.every(t => {
            if (t instanceof JavaType || t instanceof NumberLiteral || t instanceof LambdaType || t instanceof MultiValueType)
                return isTypeAssignable(dest_type, t);
            return false;
        });
    }

    let is_assignable = false;
    if (dest_type.typeSignature === value_type.typeSignature) {
        // exact signature match
        is_assignable = true;
    } else if (dest_type instanceof AnyType || value_type instanceof AnyType) {
        // everything is assignable to or from AnyType
        is_assignable = true;
    } else if (dest_type.rawTypeSignature === 'Ljava/lang/Object;') {
        // everything is assignable to Object
        is_assignable = true;
    } else if (value_type instanceof PrimitiveType) {
        // primitive values can only be assigned to wider primitives or their class equivilents
        is_assignable = valid_primitive_types.from[value_type.typeSignature].test(dest_type.typeSignature);
    } else if (dest_type instanceof PrimitiveType) {
        // primitive variables can only be assigned from narrower primitives or their class equivilents
        is_assignable = valid_primitive_types.to[dest_type.typeSignature].test(value_type.typeSignature);
    } else if (value_type instanceof NullType) {
        // null is assignable to any non-primitive
        is_assignable = !(dest_type instanceof PrimitiveType);
    } else if (value_type instanceof ArrayType) {
        // arrays are assignable to other arrays with the same dimensionality and type-assignable bases
        is_assignable = dest_type instanceof ArrayType 
                && dest_type.arrdims === value_type.arrdims
                &&  isTypeAssignable(dest_type.base, value_type.base);
    } else if (value_type instanceof CEIType && dest_type instanceof CEIType) {
        // class/interfaces types are assignable to any class/interface types in their inheritence tree
        const valid_types = getTypeInheritanceList(value_type);
        is_assignable = valid_types.includes(dest_type);
        if (!is_assignable) {
            // generic types are also assignable to their raw counterparts
            const valid_raw_types = valid_types.map(t => t.getRawType());
            is_assignable = valid_raw_types.includes(dest_type);
            if (!is_assignable) {
                // generic types are also assignable to compatible wildcard type bounds
                const raw_type = valid_raw_types.find(rt => rt.rawTypeSignature === dest_type.rawTypeSignature);
                if (raw_type instanceof CEIType && raw_type.typeVariables.length === value_type.typeVariables.length) {
                    is_assignable = dest_type.typeVariables.every((dest_tv, idx) => isTypeArgumentCompatible(dest_tv, value_type.typeVariables[idx].type));
                }
            }
        }
    } else if (dest_type instanceof TypeVariableType) {
        is_assignable = !(value_type instanceof PrimitiveType || value_type instanceof NullType);
    }
return is_assignable;
}

/**
 * @param {TypeVariable} dest_typevar 
 * @param {JavaType} value_typevar_type
 */
function isTypeArgumentCompatible(dest_typevar, value_typevar_type) {
    if (dest_typevar.type instanceof WildcardType) {
        if (!dest_typevar.type.bound) {
            // unbounded wildcard types are compatible with everything
            return true;
        }
        if (dest_typevar.type.bound.type === value_typevar_type) {
            return true;
        }
        switch (dest_typevar.type.bound.kind) {
            case 'extends':
                return isTypeAssignable(dest_typevar.type.bound.type, value_typevar_type);
            case 'super':;
                return isTypeAssignable(value_typevar_type, dest_typevar.type.bound.type);
        }
        return false;
    }
    if (value_typevar_type instanceof TypeVariableType) {
        // inferred type arguments of the form `x = List<>` are compatible with every destination type variable
        return value_typevar_type.typeVariable instanceof InferredTypeArgument;
    }
    return isTypeAssignable(dest_typevar.type, value_typevar_type);
}

/**
 * 
 * @param {ResolvedValue} value 
 * @param {() => Token[]} tokens 
 * @param {ParseProblem[]} problems 
 */
function checkBooleanBranchCondition(value, tokens, problems) {
    if (value instanceof JavaType) {
        if (!isTypeAssignable(PrimitiveType.map.Z, value)) {
            problems.push(ParseProblem.Error(tokens(), `Boolean expression expected, but type '${value.fullyDottedTypeName}' found.`));
        }
        return;
    }
    problems.push(ParseProblem.Error(tokens(), `Boolean expression expected.`));
}


/**
 * @param {CEIType} type 
 */
function getTypeInheritanceList(type) {
    const types = {
        /** @type {JavaType[]} */
        list: [type],
        /** @type {Set<JavaType>} */
        done: new Set(),
    };
    let object = null;
    for (let type; type = types.list.shift(); ) {
        // always add Object last
        if (type.rawTypeSignature === 'Ljava/lang/Object;') {
            object = type;
            continue;
        }
        if (types.done.has(type)) {
            continue;
        }
        types.done.add(type);
        if (type instanceof CEIType)
            types.list.push(...type.supers);
    }
    if (object) {
        types.done.add(object);
    }
    return Array.from(types.done);
}

exports.checkArrayIndex = checkArrayIndex;
exports.checkAssignment = checkAssignment;
exports.checkBooleanBranchCondition = checkBooleanBranchCondition;
exports.checkTypeAssignable = checkTypeAssignable;
exports.getTypeInheritanceList = getTypeInheritanceList;
exports.isTypeAssignable = isTypeAssignable;
