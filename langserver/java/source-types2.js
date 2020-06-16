const { CEIType, JavaType, PrimitiveType, Field, Method, MethodBase, Constructor, Parameter, TypeVariable } = require('java-mti');
const { Token } = require('./tokenizer');

/**
 * @param {SourceType|SourceMethod|SourceConstructor|SourceInitialiser|string} scope_or_package_name 
 * @param {string} name 
 */
function generateShortSignature(scope_or_package_name, name) {
    if (scope_or_package_name instanceof SourceType) {
        const type = scope_or_package_name;
        return `${type._rawShortSignature}$${name}`;
    }
    if (scope_or_package_name instanceof SourceMethod
        || scope_or_package_name instanceof SourceConstructor
        || scope_or_package_name instanceof SourceInitialiser) {
        const method = scope_or_package_name;
        return `${method.owner._rawShortSignature}$${method.owner.localTypeCount += 1}${name}`;
    }
    const pkgname = scope_or_package_name;
    return pkgname ?`${pkgname.replace(/\./g, '/')}/${name}` : name;
}

class SourceType extends CEIType {
    /**
     * @param {string} packageName
     * @param {SourceType|SourceMethod|SourceConstructor|SourceInitialiser} outer_scope
     * @param {string} docs 
     * @param {Token[]} modifiers 
     * @param {string} typeKind 
     * @param {Token} kind_token 
     * @param {Token} name_token 
     */
    constructor(packageName, outer_scope, docs, modifiers, typeKind, kind_token, name_token, typemap) {
        // @ts-ignore
        super(generateShortSignature(outer_scope || packageName, name_token.value), typeKind, modifiers.map(m => m.source), docs);
        super.packageName = packageName;
        this.modifierTokens = modifiers;
        this.kind_token = kind_token;
        this.nameToken = name_token;
        this.scope = outer_scope;
        this.typemap = typemap;
        /**
         * Number of local/anonymous types declared in the scope of this type
         * The number is used when naming them.
         */
        this.localTypeCount = 0;
        /** @type {SourceTypeIdent[]} */
        this.extends_types = [];
        /** @type {SourceTypeIdent[]} */
        this.implements_types = [];
        /** @type {SourceConstructor[]} */
        this.constructors = [];
        /** @type {SourceMethod[]} */
        this.methods = [];
        /** @type {SourceField[]} */
        this.fields = [];
        /** @type {SourceInitialiser[]} */
        this.initers = [];
    }

    /**
     * @param {string} package_name
     * @param {SourceType|SourceMethod|SourceConstructor|SourceInitialiser} outer_scope
     * @param {string} name
     */
    static getShortSignature(package_name, outer_scope, name) {
        return generateShortSignature(outer_scope || package_name || '', name);
    }

    /**
     * @param {Token[]} mods 
     */
    setModifierTokens(mods) {
        this.modifierTokens = mods;
        this.modifiers = mods.map(m => m.source);
    }

    get supers() {
        const supertypes = [...this.extends_types, ...this.implements_types].map(x => x.resolved);
        if (this.typeKind === 'enum') {
            /** @type {CEIType} */
            const enumtype = this.typemap.get('java/lang/Enum');
            supertypes.unshift(enumtype.specialise([this]));
        }
        else if (!supertypes.find(type => type.typeKind === 'class')) {
            supertypes.unshift(this.typemap.get('java/lang/Object'));
        }
        return supertypes;
    }
}

class SourceTypeIdent {
    /**
     * @param {Token[]} tokens 
     * @param {JavaType} type 
     */
    constructor(tokens, type) {
        this.tokens = tokens;
        this.resolved = type;
    }
}

class SourceField extends Field {
    /**
     * @param {SourceType} owner 
     * @param {Token[]} modifiers 
     * @param {SourceTypeIdent} field_type_ident 
     * @param {Token} name_token 
     * @param {ResolvedIdent} init
     */
    constructor(owner, modifiers, field_type_ident, name_token, init) {
        super(modifiers.map(m => m.value), '');
        this.owner = owner;
        this.modifierTokens = modifiers;
        this.fieldTypeIdent = field_type_ident;
        this.nameToken = name_token;
        this.init = init;
    }

    get name() {
        return this.nameToken ? this.nameToken.value : '';
    }

    get type() {
        return this.fieldTypeIdent.resolved;
    }
}

class SourceConstructor extends Constructor {
    /**
     * @param {SourceType} owner 
     * @param {TypeVariable[]} type_vars 
     * @param {Token[]} modifiers 
     * @param {SourceParameter[]} parameters 
     * @param {JavaType[]} throws 
     * @param {Token[]} body 
     */
    constructor(owner, type_vars, modifiers, parameters, throws, body) {
        super(owner, modifiers.map(m => m.value), '');
        this.owner = owner;
        this.typeVars = type_vars;
        this.modifierTokens = modifiers;
        this.sourceParameters = parameters;
        this.throws = throws;
        this.body = body;
    }

    get hasImplementation() {
        return !!this.body;
    }

    get parameterCount() {
        return this.sourceParameters.length;
    }

    /**
     * @returns {SourceParameter[]}
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

    get typeVariables() {
        return this.typeVars;
    }
}

class SourceMethod extends Method {
    /**
     * @param {SourceType} owner 
     * @param {TypeVariable[]} type_vars 
     * @param {Token[]} modifiers 
     * @param {SourceAnnotation[]} annotations
     * @param {SourceTypeIdent} method_type_ident 
     * @param {Token} name_token 
     * @param {SourceParameter[]} parameters 
     * @param {JavaType[]} throws 
     * @param {Token[]} body 
     */
    constructor(owner, type_vars, modifiers, annotations, method_type_ident, name_token, parameters, throws, body) {
        super(owner, name_token ? name_token.value : '', modifiers.map(m => m.value), '');
        this.annotations = annotations;
        this.owner = owner;
        this.typeVars = type_vars;
        this.modifierTokens = modifiers;
        this.returnTypeIdent = method_type_ident;
        this.nameToken = name_token;
        this.sourceParameters = parameters;
        this.throws = throws;
        this.body = body;
    }

    get hasImplementation() {
        return !!this.body;
    }

    get parameterCount() {
        return this.sourceParameters.length;
    }

    /**
     * @returns {SourceParameter[]}
     */
    get parameters() {
        return this.sourceParameters;
    }

    get returnType() {
        return this.returnTypeIdent.resolved;
    }

    get typeVariables() {
        return this.typeVars;
    }
}

class SourceInitialiser extends MethodBase {
    /**
     * @param {SourceType} owner
     * @param {Token[]} modifiers 
     * @param {Token[]} body 
     */
    constructor(owner, modifiers, body) {
        super(owner, modifiers.map(m => m.value), '');
        /** @type {SourceType} */
        this.owner = owner;
        this.modifierTokens = modifiers;
        this.body = body;
    }

    /**
     * @returns {SourceParameter[]}
     */
    get parameters() {
        return [];
    }

    get returnType() {
        return PrimitiveType.map.V;
    }
}

class SourceParameter extends Parameter {
    /**
     * @param {Token[]} modifiers 
     * @param {SourceTypeIdent} typeident 
     * @param {boolean} varargs 
     * @param {Token} name_token 
     */
    constructor(modifiers, typeident, varargs, name_token) {
        super(name_token ? name_token.value : '', typeident.resolved, varargs);
        this.nameToken = name_token;
        this.modifierTokens = modifiers;
        this.paramTypeIdent = typeident;
    }

    get type() {
        return this.paramTypeIdent.resolved;
    }
}

class SourceAnnotation {
    /**
     * @param {SourceTypeIdent} typeident 
     */
    constructor(typeident) {
        this.annotationTypeIdent = typeident;
    }

    get type() {
        return this.annotationTypeIdent.resolved;
    }
}

class SourcePackage {
    /**
     * @param {Token[]} tokens 
     * @param {string} name 
     */
    constructor(tokens, name) {
        this.tokens = tokens;
        this.name = name;
    }
}

class SourceImport {

    /**
     * @param {Token[]} tokens 
     * @param {Token[]} name_tokens 
     * @param {string} pkg_name 
     * @param {Token} static_token 
     * @param {Token} asterisk_token 
     * @param {import('./parsetypes/resolved-import')} resolved 
     */
    constructor(tokens, name_tokens, pkg_name, static_token, asterisk_token, resolved) {
        this.tokens = tokens;
        this.nameTokens = name_tokens;
        this.package_name = pkg_name;
        this.staticToken = static_token;
        this.asteriskToken = asterisk_token;
        this.resolved = resolved;
    }

    get isDemandLoad() {
        return !!this.asteriskToken;
    }

    get isStatic() {
        return !!this.staticToken;
    }
}

class SourceUnit {
    /** @type {SourcePackage} */
    package_ = null;
    /** @type {SourceImport[]} */
    imports = [];
    /** @type {SourceType[]} */
    types = [];
}

exports.SourceType = SourceType;
exports.SourceTypeIdent = SourceTypeIdent;
exports.SourceField = SourceField;
exports.SourceMethod = SourceMethod;
exports.SourceParameter = SourceParameter;
exports.SourceConstructor = SourceConstructor;
exports.SourceInitialiser = SourceInitialiser;
exports.SourceAnnotation = SourceAnnotation;
exports.SourceUnit = SourceUnit;
exports.SourcePackage = SourcePackage;
exports.SourceImport = SourceImport;
