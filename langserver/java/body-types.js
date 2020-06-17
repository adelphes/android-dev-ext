const { JavaType, ArrayType, Method, Parameter, Field } = require('java-mti');
const { Token } = require('./tokenizer');

class ResolvedIdent {
    /**
     * @param {string} ident
     * @param {(Local|Parameter|Field|ArrayElement|ValueBase)[]} variables
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
        /** @type {Token[]} */
        this.tokens = [];
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
     * @param {import('./source-type').SourceTypeIdent} typeIdent 
     * @param {number} postnamearrdims 
     * @param {ResolvedIdent} init 
     */
    constructor(modifiers, name, decltoken, typeIdent, postnamearrdims, init) {
        this.finalToken = modifiers.find(m => m.source === 'final') || null;
        this.name = name;
        this.decltoken = decltoken;
        if (postnamearrdims > 0) {
            typeIdent.resolved = new ArrayType(typeIdent.resolved, postnamearrdims);
        }
        this.typeIdent = typeIdent;
        this.init = init;
    }

    get type() {
        return this.typeIdent.resolved;
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

class ValueBase {}

class Value extends ValueBase {
    /**
     * @param {string} name 
     * @param {JavaType} type 
     */
    constructor(name, type) {
        super();
        this.name = name;
        this.type = type;
    }
}

class AnyValue extends Value {
    constructor(name) {
        super(name, AnyType.Instance);
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
exports.ConstructorCall = ConstructorCall;
exports.Label = Label;
exports.Local = Local;
exports.MethodCall = MethodCall;
exports.MethodDeclarations = MethodDeclarations;
exports.ResolvedIdent = ResolvedIdent;
exports.TernaryValue = TernaryValue;
exports.Value = Value;
exports.ValueBase = ValueBase;
