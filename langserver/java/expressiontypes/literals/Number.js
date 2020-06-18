/**
 * @typedef {import('../../tokenizer').Token} Token
 * @typedef {import('java-mti').JavaType} JavaType
 */
const { LiteralValue } = require('./LiteralValue');
const { PrimitiveType } = require('java-mti');

/**
 * NumberLiteral is a value representing literal numbers (like 0, 5.3, -0.1e+12, etc).
 * 
 * It allows literal numbers to be type-assignable to variables with different primitive types.
 * For example, 200 is type-assignable to short, int, long, float and double, but not byte.
 */
class NumberLiteral extends LiteralValue {
    /**
     * @param {Token} value
     * @param {string} kind
     * @param {PrimitiveType} default_type 
     */
    constructor(value, kind, default_type) {
        super(value, default_type);
        this.numberKind = kind;
    }

    static shift(a, b, op) {
        const ai = a.toInt(), bi = b.toInt();
        if (ai === null || bi === null) {
            return null;
        }
        const val = op(ai, bi);
        const type = a.type.typeSignature === 'J' ? PrimitiveType.map.J : PrimitiveType.map.I;
        return new NumberLiteral(val.toString(), 'int-number-literal', type);
    }

    static bitwise(a, b, op) {
        const ai = a.toInt(), bi = b.toInt();
        if (ai === null || bi === null) {
            return null;
        }
        const val = op(ai, bi);
        const typekey = a.type.typeSignature+ b.type.typeSignature;
        let type = /J/.test(typekey) ? PrimitiveType.map.J : PrimitiveType.map.I;
        return new NumberLiteral(val.toString(), 'int-number-literal', type);
    }

    static math(a, b, op, divmod) {
        const ai = a.toNumber(), bi = b.toNumber();
        if (bi === 0 && divmod) {
            return null;
        }
        let val = op(ai, bi);
        const typekey = a.type.typeSignature+ b.type.typeSignature;
        if (!/[FD]/.test(typekey) && divmod) {
            val = Math.trunc(val);
        }
        let type;
        if (/^(D|F[^D]|J[^FD])/.test(typekey)) {
            type = a.type;
        } else {
            type = b.type;
        }
        return new NumberLiteral(val.toString(), 'int-number-literal', type);
    }

    static '+'(lhs, rhs) { return  NumberLiteral.math(lhs, rhs, (a,b) => a + b) }
    static '-'(lhs, rhs) { return  NumberLiteral.math(lhs, rhs, (a,b) => a - b) }
    static '*'(lhs, rhs) { return  NumberLiteral.math(lhs, rhs, (a,b) => a * b) }
    static '/'(lhs, rhs) { return  NumberLiteral.math(lhs, rhs, (a,b) => a / b, true) }
    static '%'(lhs, rhs) { return  NumberLiteral.math(lhs, rhs, (a,b) => a % b, true) }
    static '&'(lhs, rhs) { return  NumberLiteral.bitwise(lhs, rhs, (a,b) => a & b) }
    static '|'(lhs, rhs) { return  NumberLiteral.bitwise(lhs, rhs, (a,b) => a | b) }
    static '^'(lhs, rhs) { return  NumberLiteral.bitwise(lhs, rhs, (a,b) => a ^ b) }
    static '>>'(lhs, rhs) { return  NumberLiteral.shift(lhs, rhs, (a,b) => a >> b) }
    static '>>>'(lhs, rhs) { return  NumberLiteral.shift(lhs, rhs, (a,b) => {
        // unsigned shift (>>>) is not supported by bigints
        // @ts-ignore
        return (a >> b) & ~(-1n << (64n - b));
    }) }
    static '<<'(lhs, rhs) { return  NumberLiteral.shift(lhs, rhs, (a,b) => a << b) }

    toInt() {
        switch (this.numberKind) {
            case 'hex-number-literal':
            case 'int-number-literal':
                // unlike parseInt, BigInt doesn't like invalid characters, so
                // ensure we strip any trailing long specifier
                return BigInt(this.token.value.match(/(.+?)[lL]?$/)[1]);
        }
        return null;
    }

    toNumber() {
        return parseFloat(this.token.value);
    }

    /**
     * @param {JavaType} type 
     */
    isCompatibleWith(type) {
        if (this.type === type) {
            return true;
        }
        switch(this.type.simpleTypeName) {
            case 'double':
                return /^([D]|Ljava\/lang\/(Double);)$/.test(type.typeSignature);
            case 'float':
                return /^([FD]|Ljava\/lang\/(Float|Double);)$/.test(type.typeSignature);
        }
        // all integral types are all compatible with long, float and double variables
        if (/^([JFD]|Ljava\/lang\/(Long|Float|Double);)$/.test(type.typeSignature)) {
            return true;
        }
        // the desintation type must be a number primitive or one of the corresponding boxed classes
        if (!/^([BSIJFDC]|Ljava\/lang\/(Byte|Short|Integer|Long|Float|Double|Character);)$/.test(type.typeSignature)) {
            return false;
        }
        let number = 0;
        if (this.numberKind === 'hex-number-literal') {
            if (this.token.value !== '0x') {
                const non_leading_zero_digits = this.token.value.match(/0x0*(.+)/)[1];
                number = non_leading_zero_digits.length > 8 ? Number.MAX_SAFE_INTEGER : parseInt(non_leading_zero_digits, 16);
            }
        } else if (this.numberKind === 'int-number-literal') {
            const non_leading_zero_digits = this.token.value.match(/0*(.+)/)[1];
            number = non_leading_zero_digits.length > 10 ? Number.MAX_SAFE_INTEGER : parseInt(non_leading_zero_digits, 10);
        }
        if (number >= -128 && number <= 127) {
            return true;    // byte values are compatible with all other numbers
        }
        if (number >= -32768 && number <= 32767) {
            return !/^([B]|Ljava\/lang\/(Byte);)$/.test(type.typeSignature);    // anything except byte
        }
        return !/^([BSC]|Ljava\/lang\/(Byte|Short|Character);)$/.test(type.typeSignature);    // anything except byte, short and character
    }

    /**
     * @param {Token} token 
     */
    static from(token) {
        function suffix(which) {
            switch(which.indexOf(token.value.slice(-1))) {
                case 0:
                case 1:
                    return PrimitiveType.map.F;
                case 2:
                case 3:
                    return PrimitiveType.map.D;
                case 4:
                case 5:
                    return PrimitiveType.map.J;
            }
        }
        switch(token.kind) {
            case 'dec-exp-number-literal':
            case 'dec-number-literal':
                return new NumberLiteral(token, token.kind, suffix('FfDdLl') || PrimitiveType.map.D);
            case 'hex-number-literal':
                return new NumberLiteral(token, token.kind, suffix('    Ll') || PrimitiveType.map.I);
            case 'int-number-literal':
            default:
                return new NumberLiteral(token, token.kind, suffix('FfDdLl') || PrimitiveType.map.I);
        }
    }
}

exports.NumberLiteral = NumberLiteral;