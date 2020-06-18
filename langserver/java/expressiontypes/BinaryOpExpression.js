/**
 * @typedef {import('../body-types').ResolvedIdent} ResolvedIdent
 * @typedef {import('../body-types').ResolveInfo} ResolveInfo
 * @typedef {import('../tokenizer').Token} Token
 */
const { Expression } = require("./Expression");
const { JavaType, PrimitiveType } = require('java-mti');
const ParseProblem = require('../parsetypes/parse-problem');
const { AnyType, TypeIdentType } = require('../anys');

class BinaryOpExpression extends Expression {
    /**
     * @param {ResolvedIdent} lhs
     * @param {Token} op
     * @param {ResolvedIdent} rhs
     */
    constructor(lhs, op, rhs) {
        super();
        this.lhs = lhs;
        this.op = op;
        this.rhs = rhs;
    }

    /**
     * @param {ResolveInfo} ri 
     */
    resolveExpression(ri) {
        const operator = this.op.value;
        const lhstype = this.lhs.resolveExpression(ri);
        const rhstype = this.rhs.resolveExpression(ri);

        if (lhstype instanceof AnyType || rhstype instanceof AnyType) {
            return AnyType.Instance;
        }

        if (operator === 'instanceof') {
            if (!(rhstype instanceof TypeIdentType)) {
                ri.problems.push(ParseProblem.Error(this.rhs.tokens, `Type expected`));
            }
            if (!(lhstype instanceof JavaType)) {
                ri.problems.push(ParseProblem.Error(this.rhs.tokens, `Expression expected`));
            }
            return PrimitiveType.map.Z;
        }

        if (!(lhstype instanceof JavaType) || !(rhstype instanceof JavaType)) {
            if (!(lhstype instanceof JavaType)) {
                ri.problems.push(ParseProblem.Error(this.lhs.tokens, `Expression expected`));
            }
            if (!(rhstype instanceof JavaType)) {
                ri.problems.push(ParseProblem.Error(this.rhs.tokens, `Expression expected`));
            }
            return AnyType.Instance;
        }

        const typekey = `${lhstype.typeSignature}#${rhstype.typeSignature}`;

        if (operator === '+' && typekey.startsWith('Ljava/lang/String;')) {
            // string appending is compatible with all types
            return lhstype;
        }

        if (/^([*/%&|^+-]?=|<<=|>>>?=)$/.test(operator)) {
            checkOperator(operator.slice(0,-1), ri, this.op, typekey, lhstype, rhstype);
            // result of assignments are lhs
            return lhstype;
        }

        return checkOperator(operator, ri, this.op, typekey, lhstype, rhstype);
    }

    tokens() {
        return [...this.lhs.tokens, this.op, ...this.rhs.tokens];
    }
}

/**
 * 
 * @param {string} operator 
 * @param {ResolveInfo} ri 
 * @param {Token} operator_token 
 * @param {string} typekey 
 * @param {JavaType} lhstype 
 * @param {JavaType} rhstype 
 */
function checkOperator(operator, ri, operator_token, typekey, lhstype, rhstype) {

    if (/^[*/%+-]$/.test(operator)) {
        // math operators - must be numeric
        if (!/^[BSIJFD]#[BSIJFD]$/.test(typekey)) {
            ri.problems.push(ParseProblem.Error(operator_token, `Operator '${operator_token.value}' is not valid for types '${lhstype.fullyDottedTypeName}' and '${rhstype.fullyDottedTypeName}'`));
        }
        if (/^(D|F#[^D]|J#[^FD]|I#[^JFD])/.test(typekey)) {
            return lhstype;
        }
        if (/^(.#D|.#F|.#J|.#I)/.test(typekey)) {
            return rhstype;
        }
        return PrimitiveType.map.I;
    }

    if (/^(<<|>>>?)$/.test(operator)) {
        // shift operators - must be integral
        if (!/^[BSIJ]#[BSIJ]$/.test(typekey)) {
            ri.problems.push(ParseProblem.Error(operator_token, `Operator '${operator_token.value}' is not valid for types '${lhstype.fullyDottedTypeName}' and '${rhstype.fullyDottedTypeName}'`));
        }
        if (/^J/.test(typekey)) {
            return PrimitiveType.map.J;
        }
        return PrimitiveType.map.I;
    }

    if (/^[&|^]$/.test(operator)) {
        // bitwise or logical operators
        if (!/^[BSIJ]#[BSIJ]$|^Z#Z$/.test(typekey)) {
            ri.problems.push(ParseProblem.Error(operator_token, `Operator '${operator_token.value}' is not valid for types '${lhstype.fullyDottedTypeName}' and '${rhstype.fullyDottedTypeName}'`));
        }
        if (/^[JZ]/.test(typekey)) {
            return lhstype;
        }
        return PrimitiveType.map.I;
    }

    if (/^(&&|\|\|)$/.test(operator)) {
        // logical operators
        if (!/^Z#Z$/.test(typekey)) {
            ri.problems.push(ParseProblem.Error(operator_token, `Operator '${operator_token.value}' is not valid for types '${lhstype.fullyDottedTypeName}' and '${rhstype.fullyDottedTypeName}'`));
        }
        return PrimitiveType.map.Z;
    }

    if (/^(>=?|<=?)$/.test(operator)) {
        // numeric comparison operators
        if (!/^[BSIJFDC]#[BSIJFDC]$/.test(typekey)) {
            ri.problems.push(ParseProblem.Error(operator_token, `Operator '${operator_token.value}' is not valid for types '${lhstype.fullyDottedTypeName}' and '${rhstype.fullyDottedTypeName}'`));
        }
        return PrimitiveType.map.Z;
    }

    // comparison operators
    if (typekey === 'Ljava/lang/String;#Ljava/lang/String;') {
        ri.problems.push(ParseProblem.Warning(operator_token, `Using equality operators '=='/'!=' to compare strings has unpredictable behaviour. Consider using String.equals(...) instead.`));
    }
    return PrimitiveType.map.Z;
}

exports.BinaryOpExpression = BinaryOpExpression;
