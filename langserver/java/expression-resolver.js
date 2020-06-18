/**
 * @typedef {import('./tokenizer').Token} Token
 */
const ParseProblem = require('./parsetypes/parse-problem');
const { TypeVariable, JavaType, PrimitiveType, NullType, ArrayType, CEIType, WildcardType, TypeVariableType, InferredTypeArgument } = require('java-mti');
const { AnyType, MultiValueType } = require('./anys');
const { ResolveInfo } = require('./body-types');
const { LiteralValue } = require('./expressiontypes/literals/LiteralValue');
const { NumberLiteral } = require('./expressiontypes/literals/Number');
const { Expression } = require('./expressiontypes/Expression');
const { Variable } = require('./expressiontypes/Variable');

/**
 * @param {import('./body-types').ResolvedIdent} e 
 * @param {JavaType} assign_type 
 * @param {Map<string,CEIType>} typemap 
 * @param {ParseProblem[]} problems
 */
function checkAssignment(e, assign_type, typemap, problems) {
    const value = e.variables[0];
    if (value instanceof Variable) {
        checkTypeAssignable(assign_type, value.type, () => value.name_token, problems);
        return;
    }
    if (value instanceof NumberLiteral) {
        if (!value.isCompatibleWith(assign_type)) {
            problems.push(ParseProblem.Error(value.token, `Incompatible types: Expression of type '${value.type.fullyDottedTypeName}' cannot be assigned to a variable of type '${assign_type.fullyDottedTypeName}'`));
        }
        return;
    }
    if (value instanceof LiteralValue) {
        checkTypeAssignable(assign_type, value.type, () => value.token, problems);
        return;
    }
    if (value instanceof Expression) {
        const expression_result_type = value.resolveExpression(new ResolveInfo(typemap, problems));
        checkTypeAssignable(assign_type, expression_result_type, () => value.tokens(), problems);
        return;
    }
}

/**
 * 
 * @param {JavaType} variable_type 
 * @param {import('./anys').ResolvedType} value_type 
 * @param {() => Token|Token[]} tokens
 */
function checkTypeAssignable(variable_type, value_type, tokens, problems) {
    if (value_type instanceof MultiValueType) {
        value_type.types.forEach(t => checkTypeAssignable(variable_type, t, tokens, problems));
        return;
    }
    if (!(value_type instanceof JavaType)) {
        return;
    }
    if (!isTypeAssignable(variable_type, value_type)) {
        const t = tokens();
        if (t.length || (t && !Array.isArray(t)))
            problems.push(ParseProblem.Error(t, `Incompatible types: Expression of type '${value_type.fullyDottedTypeName}' cannot be assigned to a variable of type '${variable_type.fullyDottedTypeName}'`));
    }
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
 * @param {JavaType} value_type 
 */
function isTypeAssignable(dest_type, value_type) {
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
    return dest_typevar.type === value_typevar_type;
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
    for (let type; type = types.list.shift(); ) {
        if (types.done.has(type)) {
            continue;
        }
        types.done.add(type);
        if (type instanceof CEIType)
            types.list.push(...type.supers);
    }
    return Array.from(types.done);
}

exports.checkAssignment = checkAssignment;
exports.getTypeInheritanceList = getTypeInheritanceList;
