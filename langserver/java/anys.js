const { JavaType, Method } = require('java-mti');
const { Expression } = require('./expressiontypes/Expression');

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

exports.AnyMethod = AnyMethod;
exports.AnyType = AnyType;
exports.AnyValue = AnyValue;
