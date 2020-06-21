/**
 * @typedef {import('../body-types').ResolvedIdent} ResolvedIdent
 * @typedef {import('../body-types').ResolveInfo} ResolveInfo
 * @typedef {import('../anys').ResolvedValue} ResolvedValue
 */
const { Expression } = require("./Expression");
const { AnyType, MultiValueType, TypeIdentType } = require('../anys');
const ParseProblem = require('../parsetypes/parse-problem');
const { JavaType, PrimitiveType, NullType, CEIType, ArrayType } = require('java-mti');
const { getTypeInheritanceList } = require('../expression-resolver');
const { NumberLiteral } = require('../expressiontypes/literals/Number');

class CastExpression extends Expression {
    /**
     * @param {ResolvedIdent} castType
     * @param {ResolvedIdent} expression
     */
    constructor(castType, expression) {
        super();
        this.castType = castType;
        this.expression = expression;
    }

    /**
     * @param {ResolveInfo} ri 
     */
    resolveExpression(ri) {
        const cast_type = this.castType.resolveExpression(ri);
        if (cast_type instanceof TypeIdentType) {
            const expr_type  = this.expression.resolveExpression(ri);
            checkCastable(this, cast_type.type, expr_type, ri.problems);
            return cast_type.type;
        }
        if (cast_type instanceof AnyType) {
            return cast_type;
        }
        ri.problems.push(ParseProblem.Error(this.castType.tokens, 'Type expected'))
        return AnyType.Instance;
    }

    tokens() {
        return [...this.castType.tokens, ...this.expression.tokens];
    }
}

/**
 * @param {CastExpression} cast
 * @param {JavaType} cast_type 
 * @param {ResolvedValue} expr_type 
 * @param {ParseProblem[]} problems 
 */
function checkCastable(cast, cast_type, expr_type, problems) {
    if (expr_type instanceof JavaType) {
        if (!isTypeCastable(expr_type, cast_type)) {
            problems.push(ParseProblem.Error(cast.expression.tokens, `Invalid cast: An expression of type '${expr_type.fullyDottedTypeName}' cannot be cast to type '${cast_type.fullyDottedTypeName}'`));
        }
        return;
    }
    if (expr_type instanceof NumberLiteral) {
        checkCastable(cast, cast_type, expr_type.type, problems);
        return;
    }
    if (expr_type instanceof MultiValueType) {
        expr_type.types.forEach(type => checkCastable(cast, cast_type, type, problems));
        return;
    }
    problems.push(ParseProblem.Error(cast.expression.tokens, `Invalid cast: expression is not a value or variable`));
}

/**
 * @param {JavaType} source_type 
 * @param {JavaType} cast_type 
 */
function isTypeCastable(source_type, cast_type) {
    if (source_type.typeSignature === 'Ljava/lang/Object;') {
        // everything is castable from Object
        return true;
    }
    if (cast_type.typeSignature === 'Ljava/lang/Object;') {
        // everything is castable to Object
        return true;
    }
    if (source_type instanceof NullType) {
        // null is castable to any non-primitive
        return !(cast_type instanceof PrimitiveType);
    }
    if (source_type instanceof CEIType && cast_type instanceof CEIType) {
        if (source_type.typeKind === 'interface') {
            // interfaces are castable to any non-final class type (derived types might implement the interface)
            if (cast_type.typeKind === 'class' && !cast_type.modifiers.includes('final')) {
                return true;
            }
        }
        // for other class casts, one type must be in the inheritence tree of the other
        if (getTypeInheritanceList(source_type).includes(cast_type)) {
            return true;
        }
        if (getTypeInheritanceList(cast_type).includes(source_type)) {
            return true;
        }
        return false;
    }
    if (cast_type instanceof PrimitiveType) {
        // source type must be a compatible primitive or class
        switch (cast_type.typeSignature) {
            case 'B':
            case 'S':
            case 'I':
            case 'J': 
            case 'C': 
            case 'F':
            case 'D':
                return /^([BSIJCFD]|Ljava\/lang\/(Byte|Short|Integer|Long|Character|Float|Double);)$/.test(source_type.typeSignature);
            case 'Z':
                return /^([Z]|Ljava\/lang\/(Boolean);)$/.test(source_type.typeSignature);
        }
        return false;
    }
    if (cast_type instanceof ArrayType) {
        // the source type must have the same array dimensionality and have a castable base type
        if (source_type instanceof ArrayType) {
            if (source_type.arrdims === cast_type.arrdims) {
                if (isTypeCastable(source_type.base, cast_type.base)) {
                    return true;
                }
            }
        }
    }

    if (source_type instanceof AnyType || cast_type instanceof AnyType) {
        return true;
    }

    return false;
}

exports.CastExpression = CastExpression;
