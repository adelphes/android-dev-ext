const { JavaType, ArrayType, PrimitiveType, Method, Parameter, Field } = require('java-mti');
const { Token } = require('./tokenizer');

class ResolvedIdent {
    /**
     * @param {string} ident
     * @param {(Local|Parameter|Field|ArrayElement|Value)[]} variables
     * @param {Method[]} methods
     * @param {JavaType[]} types
     * @param {string} package_name
     */
    constructor(ident, variables = [], methods = [], types = [], package_name = '') {
        this.source = ident;
        this.variables = variables;
        this.methods = methods;
        this.types = types;
        this.package_name = package_name;
    }
}

/**
 * AnyType is a special type that's used to fill in types that are missing.
 * To prevent cascading errors, AnyType should be fully assign/cast/type-compatible
 * with any other type
 */
class AnyType extends JavaType {
    /**
     *
     * @param {String} label
     */
    constructor(label) {
        super("class", [], '');
        super.simpleTypeName = label || '<unknown type>';
    }

    static Instance = new AnyType('');

    get rawTypeSignature() {
        return 'U';
    }

    get typeSignature() {
        return 'U';
    }
}

class AnyMethod extends Method {
    /**
     * @param {string} name 
     */
    constructor(name) {
        super(null, name, [], '');
    }

    get returnType() {
        return AnyType.Instance;
    }
}

class Local {
    /**
     * @param {Token[]} modifiers 
     * @param {string} name 
     * @param {Token} decltoken 
     * @param {JavaType} type 
     * @param {JavaType} type 
     * @param {number} postnamearrdims 
     */
    constructor(modifiers, name, decltoken, type, postnamearrdims) {
        this.finalToken = modifiers.find(m => m.source === 'final') || null;
        this.name = name;
        this.decltoken = decltoken;
        this.type = postnamearrdims > 0 ? new ArrayType(type, postnamearrdims): type;
        this.init = null;
    }
}

class Label {
    /**
     * @param {Token} token 
     */
    constructor(token) {
        this.name_token = token;
    }
}

class MethodDeclarations {
    /** @type {Local[]} */
    locals = [];
    /** @type {Label[]} */
    labels = [];
    /** @type {import('./source-types2').SourceType[]} */
    types = [];

    _scopeStack = [];

    pushScope() {
        this._scopeStack.push([this.locals, this.labels, this.types]);
        this.locals = this.locals.slice();
        this.labels = this.labels.slice();
        this.types = this.types.slice();
    }

    popScope() {
        [this.locals, this.labels, this.types] = this._scopeStack.pop();
    }
}

class ArrayElement {
    /**
     * 
     * @param {Local|Parameter|Field|ArrayElement|Value} array_variable 
     * @param {ResolvedIdent} index 
     */
    constructor(array_variable, index) {
        this.array_variable = array_variable;
        this.index = index;
        if (!(this.array_variable.type instanceof ArrayType)) {
            throw new Error('Array element cannot be created from non-array type');
        }
        this.name = `${array_variable.name}[${index.source}]`;
        /** @type {JavaType} */
        this.type = this.array_variable.type.elementType;
    }
}

class Value {
    /**
     * @param {string} name 
     * @param {JavaType} type 
     */
    constructor(name, type) {
        this.name = name;
        this.type = type;
    }

    /**
     * @param {string} ident 
     * @param {ResolvedIdent} lhs 
     * @param {ResolvedIdent} rhs 
     * @param {JavaType} type 
     */
    static build(ident, lhs, rhs, type) {
        if (!lhs.variables[0] || !rhs.variables[0]) {
            return new Value(ident, type);
        }
        if (lhs.variables[0] instanceof LiteralValue && rhs.variables && rhs.variables[0] instanceof LiteralValue) {
            new LiteralValue(ident, type);
        }
        return new Value(ident, type);
    }
}

class AnyValue extends Value {
    constructor(name) {
        super(name, AnyType.Instance);
    }
}

class LiteralValue extends Value { }

/**
 * LiteralNumberType is a value representing literal numbers (like 0, 5.3, -0.1e+12, etc).
 * 
 * It's used to allow literal numbers to be type-assignable to variables with different primitive types.
 * For example, 200 is type-assignable to short, int, long, float and double, but not byte.
 */
class LiteralNumber extends LiteralValue {
    /**
     * @param {string} value
     * @param {string} kind
     * @param {PrimitiveType} default_type 
     */
    constructor(value, kind, default_type) {
        super(value, default_type);
        this.numberValue = value;
        this.numberKind = kind;
    }

    static shift(a, b, op) {
        const ai = a.toInt(), bi = b.toInt();
        if (ai === null || bi === null) {
            return null;
        }
        const val = op(ai, bi);
        const type = a.type.typeSignature === 'J' ? PrimitiveType.map.J : PrimitiveType.map.I;
        return new LiteralNumber(val.toString(), 'int-number-literal', type);
    }

    static bitwise(a, b, op) {
        const ai = a.toInt(), bi = b.toInt();
        if (ai === null || bi === null) {
            return null;
        }
        const val = op(ai, bi);
        const typekey = a.type.typeSignature+ b.type.typeSignature;
        let type = /J/.test(typekey) ? PrimitiveType.map.J : PrimitiveType.map.I;
        return new LiteralNumber(val.toString(), 'int-number-literal', type);
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
        return new LiteralNumber(val.toString(), 'int-number-literal', type);
    }

    static '+'(lhs, rhs) { return  LiteralNumber.math(lhs, rhs, (a,b) => a + b) }
    static '-'(lhs, rhs) { return  LiteralNumber.math(lhs, rhs, (a,b) => a - b) }
    static '*'(lhs, rhs) { return  LiteralNumber.math(lhs, rhs, (a,b) => a * b) }
    static '/'(lhs, rhs) { return  LiteralNumber.math(lhs, rhs, (a,b) => a / b, true) }
    static '%'(lhs, rhs) { return  LiteralNumber.math(lhs, rhs, (a,b) => a % b, true) }
    static '&'(lhs, rhs) { return  LiteralNumber.bitwise(lhs, rhs, (a,b) => a & b) }
    static '|'(lhs, rhs) { return  LiteralNumber.bitwise(lhs, rhs, (a,b) => a | b) }
    static '^'(lhs, rhs) { return  LiteralNumber.bitwise(lhs, rhs, (a,b) => a ^ b) }
    static '>>'(lhs, rhs) { return  LiteralNumber.shift(lhs, rhs, (a,b) => a >> b) }
    static '>>>'(lhs, rhs) { return  LiteralNumber.shift(lhs, rhs, (a,b) => {
        // unsigned shift (>>>) is not supported by bigints
        // @ts-ignore
        return (a >> b) & ~(-1n << (64n - b));
    }) }
    static '<<'(lhs, rhs) { return  LiteralNumber.shift(lhs, rhs, (a,b) => a << b) }

    toInt() {
        switch (this.numberKind) {
            case 'hex-number-literal':
            case 'int-number-literal':
                // unlike parseInt, BigInt doesn't like invalid characters, so
                // ensure we strip any trailing long specifier
                return BigInt(this.name.match(/(.+?)[lL]?$/)[1]);
        }
        return null;
    }

    toNumber() {
        return parseFloat(this.name);
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
            if (this.numberValue !== '0x') {
                const non_leading_zero_digits = this.numberValue.match(/0x0*(.+)/)[1];
                number = non_leading_zero_digits.length > 8 ? Number.MAX_SAFE_INTEGER : parseInt(non_leading_zero_digits, 16);
            }
        } else if (this.numberKind === 'int-number-literal') {
            const non_leading_zero_digits = this.numberValue.match(/0*(.+)/)[1];
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
                return new LiteralNumber(token.value, token.kind, suffix('FfDdLl') || PrimitiveType.map.D);
            case 'hex-number-literal':
                return new LiteralNumber(token.value, token.kind, suffix('    Ll') || PrimitiveType.map.I);
            case 'int-number-literal':
            default:
                return new LiteralNumber(token.value, token.kind, suffix('FfDdLl') || PrimitiveType.map.I);
        }
    }
}

class MethodCall extends Value {
    /**
     * @param {string} name 
     * @param {ResolvedIdent} instance
     * @param {Method} method 
     */
    constructor(name, instance, method) {
        super(name, method.returnType);
        this.instance = instance;
        this.method = method;
    }
}

class ConstructorCall extends Value {
    /**
     * @param {string} name 
     * @param {JavaType} type
     */
    constructor(name, type) {
        super(name, type);
    }
}

class ArrayLiteral extends LiteralValue {
    /**
     * @param {string} name 
     * @param {ResolvedIdent[]} elements 
     */
    constructor(name, elements) {
        super(name, null);
        this.elements = elements;
    }
}

class TernaryValue extends Value {
    /**
     * @param {string} name 
     * @param {JavaType} true_type
     * @param {Token} colon
     * @param {Value} false_value
     */
    constructor(name, true_type, colon, false_value) {
        super(name, true_type);
        this.colon = colon;
        this.falseValue = false_value;
    }
}

exports.AnyMethod = AnyMethod;
exports.AnyType = AnyType;
exports.AnyValue = AnyValue;
exports.ArrayElement = ArrayElement;
exports.ArrayLiteral = ArrayLiteral;
exports.ConstructorCall = ConstructorCall;
exports.Label = Label;
exports.LiteralNumber = LiteralNumber;
exports.LiteralValue = LiteralValue;
exports.Local = Local;
exports.MethodCall = MethodCall;
exports.MethodDeclarations = MethodDeclarations;
exports.ResolvedIdent = ResolvedIdent;
exports.TernaryValue = TernaryValue;
exports.Value = Value;
