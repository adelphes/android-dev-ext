/**
 * @typedef {import('../../tokenizer').Token} Token
 * @typedef {import('java-mti').JavaType} JavaType
 * @typedef {import('../../body-types').ResolveInfo} ResolveInfo
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
     * @param {Token[]} tokens
     * @param {string} kind
     * @param {PrimitiveType} default_type 
     * @param {string} [value]
     */
    constructor(tokens, kind, default_type, value = tokens[0].value) {
        super(tokens, default_type);
        this.value = value;
        this.numberKind = kind;
    }

    /**
     * @param {ResolveInfo} ri 
     */
    resolveExpression(ri) {
        return this;
    }

    /**
     * @param {NumberLiteral} a 
     * @param {NumberLiteral} b 
     * @param {string} kind 
     * @param {PrimitiveType} type 
     * @param {number} value 
     */
    static calc(a, b, kind, type, value) {
        let atoks = a.tokens(), btoks = b.tokens();
        atoks = Array.isArray(atoks) ? atoks : [atoks];
        btoks = Array.isArray(btoks) ? btoks : [btoks];
        return new NumberLiteral([...atoks, ...btoks], kind, type, value.toString());
    }

    /**
     * @param {NumberLiteral} a 
     * @param {NumberLiteral} b 
     * @param {(a,b) => Number} op 
     */
    static shift(a, b, op) {
        const ai = a.toInt(), bi = b.toInt();
        if (ai === null || bi === null) {
            return null;
        }
        const val = op(ai, bi);
        const type = a.type.typeSignature === 'J' ? PrimitiveType.map.J : PrimitiveType.map.I;
        return NumberLiteral.calc(a, b, 'int-number-literal', type, val);
    }

    /**
     * @param {NumberLiteral} a 
     * @param {NumberLiteral} b 
     * @param {(a,b) => Number} op 
     */
    static bitwise(a, b, op) {
        const ai = a.toInt(), bi = b.toInt();
        if (ai === null || bi === null) {
            return null;
        }
        const val = op(ai, bi);
        const typekey = a.type.typeSignature+ b.type.typeSignature;
        const type = /J/.test(typekey) ? PrimitiveType.map.J : PrimitiveType.map.I;
        return NumberLiteral.calc(a, b, 'int-number-literal', type, val);
    }

    /**
     * @param {NumberLiteral} a 
     * @param {string} opvalue
     * @param {(a) => Number} op 
     */
    static unary(a, opvalue, op) {
        if (opvalue === '-') {
            const ai = a.toNumber();
            if (ai === null) {
                return null;
            }
            const val = op(ai);
            const type = PrimitiveType.map[a.type.typeSignature];
            const toks = a.tokens();
            return new NumberLiteral(Array.isArray(toks) ? toks : [toks], 'int-number-literal', type, val.toString());
        }
        const ai = a.toInt();
        if (ai === null) {
            return null;
        }
        const val = op(ai);
        const type = /J/.test(a.type.typeSignature) ? PrimitiveType.map.J : PrimitiveType.map.I;
        const toks = a.tokens();
        return new NumberLiteral(Array.isArray(toks) ? toks : [toks], 'int-number-literal', type, val.toString());
    }

    /**
     * @param {NumberLiteral} a 
     * @param {NumberLiteral} b 
     * @param {(a,b) => Number} op 
     */
    static math(a, b, op) {
        const ai = a.toNumber(), bi = b.toNumber();
        let val = op(ai, bi);
        const typekey = a.type.typeSignature + b.type.typeSignature;
        if (!/[FD]/.test(typekey)) {
            val = Math.trunc(val);
        }
        const type = typekey.includes('D') ? PrimitiveType.map.D
            : typekey.includes('F') ? PrimitiveType.map.F
            : typekey.includes('J') ? PrimitiveType.map.J
            : PrimitiveType.map.I;
        // note: Java allows integer division by zero at compile-time - it will
        // always cause an ArithmeticException at runtime, so the result here (inf or nan)
        // is largely meaningless
        return NumberLiteral.calc(a, b, 'int-number-literal', type, val);
    }

    static '~'(value) { return  NumberLiteral.unary(value, '~', (a) => ~a) }
    static '+'(lhs, rhs) { return !rhs
        ? lhs // unary e.g +5
        : NumberLiteral.math(lhs, rhs, (a,b) => a + b)
    }
    static '-'(lhs, rhs) { return !rhs
        ? NumberLiteral.unary(lhs, '-', (a) => -a)
        : NumberLiteral.math(lhs, rhs, (a,b) => a - b)
    }
    static '*'(lhs, rhs) { return  NumberLiteral.math(lhs, rhs, (a,b) => a * b) }
    static '/'(lhs, rhs) { return  NumberLiteral.math(lhs, rhs, (a,b) => a / b) }
    static '%'(lhs, rhs) { return  NumberLiteral.math(lhs, rhs, (a,b) => a % b) }
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
                return BigInt(this.value.match(/(.+?)[lL]?$/)[1]);
        }
        return null;
    }

    toNumber() {
        return parseFloat(this.value);
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
            if (this.value !== '0x') {
                const non_leading_zero_digits = this.value.match(/0x0*(.+)/)[1];
                number = non_leading_zero_digits.length > 8 ? Number.MAX_SAFE_INTEGER : parseInt(non_leading_zero_digits, 16);
            }
        } else if (this.numberKind === 'int-number-literal') {
            const non_leading_zero_digits = this.value.match(/0*(.+)/)[1];
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
                return new NumberLiteral([token], token.kind, suffix('FfDdLl') || PrimitiveType.map.D);
            case 'hex-number-literal':
                return new NumberLiteral([token], token.kind, suffix('    Ll') || PrimitiveType.map.I);
            case 'int-number-literal':
            default:
                return new NumberLiteral([token], token.kind, suffix('FfDdLl') || PrimitiveType.map.I);
        }
    }
}

exports.NumberLiteral = NumberLiteral;