const { JavaType, Method } = require('java-mti');
const { Expression } = require('./expressiontypes/Expression');
/**
 * @typedef {import('./tokenizer').Token} Token
 */

/**
 * Custom type designed to be used where a type is missing or unresolved.
 * 
 * AnyType should be fully assign/cast/type-compatible with any other type
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

/**
 * Custom method designed to be compatible with
 * any arguments in method call
 */
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

/**
 * Custom expression designed to be compatiable with
 * any variable or operator
 */
class AnyValue extends Expression {
    /**
     *
     * @param {String} label
     */
    constructor(label) {
        super();
        this.label = label;
        this.type = AnyType.Instance;
    }
}

/**
 * Custom type used to represent a method identifier
 * 
 * e.g `"".length`
 */
class MethodType {
    /**
     * @param {Method[]} methods
     */
    constructor(methods) {
        this.methods = methods;
    }
}

/**
 * Custom type used to represent a lambda expression
 * 
 * eg. `() => null`
 */
class LambdaType {

}

/**
 * Custom type used to represent type name expressions
 * 
 * eg. `x instanceof String`
 */
class TypeIdentType {
    /**
     * @param {JavaType} type
     */
    constructor(type) {
        this.type = type;
    }
}

/**
 * Custom type used to represent an array literal
 * 
 * eg. `new int[] { 1,2,3 }`
 */
class ArrayValueType {
    /**
     * @param {{tokens:Token[], value: ResolvedValue}[]} elements
     */
    constructor(elements) {
        this.elements = elements;
    }
}

/**
 * Custom type used to represent the types of a 
 * expression that can return multiple distinct types
 * 
 * eg. `x == null ? 0 : 'c'`
 */
class MultiValueType {
    /**
     * @param {ResolvedValue[]} types
     */
    constructor(...types) {
        this.types = types;
    }
}

/**
 * @typedef {import('./expressiontypes/literals/Number').NumberLiteral} NumberLiteral
 * @typedef {JavaType|MethodType|LambdaType|ArrayValueType|TypeIdentType|MultiValueType|NumberLiteral} ResolvedValue
 **/

exports.AnyMethod = AnyMethod;
exports.AnyType = AnyType;
exports.AnyValue = AnyValue;
exports.ArrayValueType = ArrayValueType;
exports.LambdaType = LambdaType;
exports.MethodType = MethodType;
exports.MultiValueType = MultiValueType;
exports.TypeIdentType = TypeIdentType;
