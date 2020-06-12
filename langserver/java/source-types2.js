const { CEIType, JavaType, Field, Method, Constructor, Parameter } = require('java-mti');
const { SourceMethod, SourceConstructor, SourceInitialiser } = require('./source-type');
const { Token } = require('./tokenizer');

/**
 * @param {SourceType|SourceMethod|SourceConstructor|SourceInitialiser|string} scope_or_package_name 
 * @param {Token} name 
 */
function generateShortSignature(scope_or_package_name, name) {
    if (scope_or_package_name instanceof SourceType) {
        const type = scope_or_package_name;
        return `${type._rawShortSignature}$${name.value}`;
    }
    if (scope_or_package_name instanceof SourceMethod
        || scope_or_package_name instanceof SourceConstructor
        || scope_or_package_name instanceof SourceInitialiser) {
        const method = scope_or_package_name;
        return `${method.owner._rawShortSignature}$${method.owner.localTypeCount += 1}${name.value}`;
    }
    const pkgname = scope_or_package_name;
    return pkgname ?`${pkgname.replace(/\./g, '/')}/${name.value}` : name.value;
}

class SourceType extends CEIType {
    /**
     * @param {string} packageName
     * @param {SourceType|SourceMethod2|SourceConstructor|SourceInitialiser} outer_scope
     * @param {string} docs 
     * @param {string[]} modifiers 
     * @param {Token} kind_token 
     * @param {Token} name_token 
     */
    constructor(packageName, outer_scope, docs, modifiers, kind_token, name_token) {
        // @ts-ignore
        super(generateShortSignature(outer_scope || packageName, name_token), kind_token.source, modifiers, docs);
        super.packageName = packageName;
        this.kind_token = kind_token;
        this.name_token = name_token;
        this.scope = outer_scope;
        /**
         * Number of local/anonymous types declared in the scope of this type
         * The number is used when naming them.
         */
        this.localTypeCount = 0;
        /** @type {SourceConstructor2[]} */
        this.constructors = [];
        /** @type {SourceMethod2[]} */
        this.methods = [];
        /** @type {SourceField2[]} */
        this.fields = [];
    }

}

class SourceField2 extends Field {
    /**
     * @param {SourceType} owner 
     * @param {Token[]} modifiers 
     * @param {JavaType} field_type 
     * @param {Token} name_token 
     */
    constructor(owner, modifiers, field_type, name_token) {
        super(modifiers.map(m => m.value), '');
        this.owner = owner;
        this.fieldType = field_type;
        this.nameToken = name_token;
    }

    get name() {
        return this.nameToken ? this.nameToken.value : '';
    }

    get type() {
        return this.fieldType;
    }
}

class SourceConstructor2 extends Constructor {
    /**
     * @param {SourceType} owner 
     * @param {Token[]} modifiers 
     * @param {SourceParameter2[]} parameters 
     * @param {JavaType[]} throws 
     * @param {Token[]} body 
     */
    constructor(owner, modifiers, parameters, throws, body) {
        super(owner, modifiers.map(m => m.value), '');
        this.owner = owner;
        this.sourceParameters = parameters;
        this.throws = throws;
        this.body_tokens = body;
    }

    get hasImplementation() {
        return !!this.body_tokens;
    }

    get parameterCount() {
        return this.sourceParameters.length;
    }

    /**
     * @returns {SourceParameter2[]}
     */
    get parameters() {
        return this.sourceParameters;
    }

    /**
     * @returns {SourceType}
     */
    get returnType() {
        return this.owner;
    }
}

class SourceMethod2 extends Method {
    /**
     * @param {SourceType} owner 
     * @param {Token[]} modifiers 
     * @param {JavaType} method_type 
     * @param {Token} name_token 
     * @param {SourceParameter2[]} parameters 
     * @param {JavaType[]} throws 
     * @param {Token[]} body 
     */
    constructor(owner, modifiers, method_type, name_token, parameters, throws, body) {
        super(owner, name_token ? name_token.value : '', modifiers.map(m => m.value), '');
        this.owner = owner;
        this.methodType = method_type;
        this.sourceParameters = parameters;
        this.throws = throws;
        this.body_tokens = body;
    }

    get hasImplementation() {
        return !!this.body_tokens;
    }

    get parameterCount() {
        return this.sourceParameters.length;
    }

    /**
     * @returns {SourceParameter2[]}
     */
    get parameters() {
        return this.sourceParameters;
    }

    /**
     * @returns {JavaType}
     */
    get returnType() {
        return this.methodType;
    }
}

class SourceParameter2 extends Parameter {
    /**
     * @param {Token[]} modifiers 
     * @param {JavaType} type 
     * @param {boolean} varargs 
     * @param {Token} name_token 
     */
    constructor(modifiers, type, varargs, name_token) {
        super(name_token ? name_token.value : '', type, varargs);
        this.name_token = name_token;
        this.modifiers = modifiers;
    }
}

exports.SourceType = SourceType;
exports.SourceField2 = SourceField2;
exports.SourceMethod2 = SourceMethod2;
exports.SourceParameter2 = SourceParameter2;
exports.SourceConstructor2 = SourceConstructor2;
