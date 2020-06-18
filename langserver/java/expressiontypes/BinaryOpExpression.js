/**
 * @typedef {import('../body-types').ResolvedIdent} ResolvedIdent
 * @typedef {import('../body-types').ResolveInfo} ResolveInfo
 * @typedef {import('../tokenizer').Token} Token
 */
const { Expression } = require("./Expression");
const { JavaType, PrimitiveType } = require('java-mti');

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
        if (operator === '+') {
            const lhstypesig = lhstype instanceof JavaType && lhstype.typeSignature,
                rhstypesig = rhstype instanceof JavaType && rhstype.typeSignature;
            if (lhstypesig === 'Ljava/lang/String;') {
                return lhstype;
            }
            if (lhstypesig === 'D' || rhstypesig === 'D') {
                return PrimitiveType.map.D;
            }
            if (lhstypesig === 'F' || rhstypesig === 'F') {
                return PrimitiveType.map.F;
            }
            if (lhstypesig === 'J' || rhstypesig === 'J') {
                return PrimitiveType.map.J;
            }
            return PrimitiveType.map.I;
        }
        if (/^([*/%&|^+-]?=|<<=|>>>?=)$/.test(operator)) {
            // result of assignments are lhs
            return lhstype;
        }
        if (/^[*/%-]$/.test(operator)) {
            // math operators
            return PrimitiveType.map.I;
        }
        if (/^(<<|>>>?)$/.test(operator)) {
            // shift operators
            return PrimitiveType.map.I;
        }
        if (/^[&|^]$/.test(operator)) {
            // bitwise or logical operators
            return lhstype === PrimitiveType.map.Z ? lhstype : PrimitiveType.map.I;
        }
        if (operator === 'instanceof') {
        }
        // logical/comparison operators
        return PrimitiveType.map.Z;
    }

    tokens() {
        return [...this.lhs.tokens, this.op, ...this.rhs.tokens];
    }
}

exports.BinaryOpExpression = BinaryOpExpression;
