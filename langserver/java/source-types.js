const { CEIType, JavaType, PrimitiveType, ArrayType, TypeVariableType, Field, Method, MethodBase, Constructor, Parameter, TypeVariable, TypeArgument } = require('java-mti');
const { Token } = require('./tokenizer');

/**
 * @typedef {import('./body-types').ResolvedIdent} ResolvedIdent
 */

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

/**
 * @param {SourceType} enum_type 
 * @param {Map<string,CEIType>} typemap
 */
function createImplicitEnumMethods(enum_type, typemap) {
    return [
        new class extends Method {
            constructor() {
                super(enum_type, 'values', ['public','static'], '');
                this._returnType = new ArrayType(enum_type, 1);
            }
            get returnType() {
                return this._returnType;
            }
        },
        new class extends Method {
            constructor() {
                super(enum_type, 'valueOf', ['public','static'], '');
                this._parameters = [
                    new Parameter('name', typemap.get('java/lang/String'), false)
                ]
                this._returnType = enum_type;
            }
            get parameters() {
                return this._parameters;
            }
            get returnType() {
                return this._returnType;
            }
        }
    ];
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
     * @param {Map<string,CEIType>} typemap
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
        /** @type {Method[]} */
        this.methods = typeKind === 'enum'
            ? createImplicitEnumMethods(this, typemap)
            : [];        
        /** @type {SourceField[]} */
        this.fields = [];
        /** @type {SourceInitialiser[]} */
        this.initers = [];
        /** @type {SourceEnumValue[]} */
        this.enumValues = [];
    }

    /**
     * @returns {SourceMethod[]}
     */
    get sourceMethods() {
        // @ts-ignore
        return this.methods.filter(m => m instanceof SourceMethod);// [...this.implicitMethods, ...this.sourceMethods];
    }

    /**
     * @param {string} docs 
     * @param {Token} ident 
     * @param {ResolvedIdent[]} ctr_args 
     * @param {SourceType} anonymousType
     */
    addEnumValue(docs, ident, ctr_args, anonymousType) {
        this.enumValues.push(new SourceEnumValue(this, docs, ident, ctr_args, anonymousType));
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

    /**
     * @param {JavaType[]} types 
     * @returns {CEIType}
     */
    specialise(types) {
        const short_sig = `${this.shortSignature}<${types.map(t => t.typeSignature).join('')}>`;
        if (this.typemap.has(short_sig)) {
            // @ts-ignore
            return this.typemap.get(short_sig);
        }
        /** @type {'class'|'enum'|'interface'|'@interface'} */
        // @ts-ignore
        const typeKind = this.typeKind;
        const specialised_type = new SpecialisedSourceType(this, typeKind, this._rawShortSignature, types);
        this.typemap.set(short_sig, specialised_type);
        return specialised_type;
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

class SpecialisedSourceType extends CEIType {
    /**
     * 
     * @param {SourceType} source_type 
     * @param {'class'|'enum'|'interface'|'@interface'} typeKind
     * @param {string} raw_short_signature 
     * @param {JavaType[]} types 
     */
    constructor(source_type, typeKind, raw_short_signature, types) {
        super(raw_short_signature, typeKind, source_type.modifiers, source_type.docs);
        this.source_type = source_type;
        this.typemap = source_type.typemap;
        /** @type {TypeArgument[]} */
        // @ts-ignore
        const type_args = source_type.typeVariables.map((tv, idx) => new TypeArgument(this, tv, types[idx] || this.typemap.get('java/lang/Object')));
        this.typeVariables = type_args;

        function resolveType(type, typevars = []) {
            if (type instanceof ArrayType) {
                return new ArrayType(resolveType(type.base, typevars), type.arrdims);
            }
            if (!(type instanceof TypeVariableType)) {
                return type;
            }
            if (typevars.includes(type.typeVariable)) {
                return type;
            }
            const specialised_type = type_args.find(ta => ta.name === type.typeVariable.name);
            return specialised_type.type;
        }

        this.fields = source_type.fields.map(f => {
            const type = this;
            return new class extends Field {
                constructor() {
                    super(f.modifiers, f.docs);
                    this.owner = type;
                    this.source = f;
                    this.fieldType = resolveType(f.fieldTypeIdent.resolved);
                }
                get name() { return this.source.name } 
                get type() { return this.fieldType }
            };
        });

        this.constructors = source_type.constructors.map(c => {
            const type = this;
            return new class extends Constructor {
                constructor() {
                    super(type, c.modifiers, c.docs);
                    this.owner = type;
                    this.source = c;
                    this._parameters = c.sourceParameters.map(p => new Parameter(p.name, resolveType(p.paramTypeIdent.resolved, c.typeVariables), p.varargs));
                }
                get hasImplementation() {
                    return !!this.source.body;
                }
                get parameters() {
                    return this._parameters;
                }
                get typeVariables() {
                    return this.source.typeVars;
                }
            
            };
        });
        this.methods = source_type.methods.map(method => {
            if (!(method instanceof SourceMethod)) {
                return method;
            }
            const m = method;
            const type = this;
            return new class extends Method {
                constructor() {
                    super(type, m.name, m.modifiers, m.docs);
                    this.owner = type;
                    this.source = m;
                    this._returnType = resolveType(m.returnType, m.typeVars)
                    this._parameters = m.sourceParameters.map(p => new Parameter(p.name, resolveType(p.type, m.typeVars), p.varargs));
                }
                get hasImplementation() {
                    return !!this.source.body;
                }
                get parameters() {
                    return this._parameters;
                }
                get returnType() {
                    return this._returnType;
                }
                get typeVariables() {
                    return this.source.typeVars;
                }
            };
        });
    }

    /**
     * @param {JavaType[]} types 
     * @returns {CEIType}
     */
    specialise(types) {
        const short_sig = `${this._rawShortSignature}<${types.map(t => t.typeSignature).join('')}>`;
        if (this.typemap.has(short_sig)) {
            // @ts-ignore
            return this.typemap.get(short_sig);
        }
        /** @type {'class'|'enum'|'interface'|'@interface'} */
        // @ts-ignore
        const typeKind = this.typeKind;
        const specialised_type = new SpecialisedSourceType(this.source_type, typeKind, this._rawShortSignature, types);
        this.typemap.set(short_sig, specialised_type);
        return specialised_type;
    }

}

class SourceEnumValue extends Field {
    /**
     * @param {SourceType} owner
     * @param {string} docs 
     * @param {Token} ident 
     * @param {ResolvedIdent[]} ctr_args 
     * @param {SourceType} anonymousType
     */
    constructor(owner, docs, ident, ctr_args, anonymousType) {
        super(['public','static','final'], docs);
        this.owner = owner;
        this.ident = ident;
        this.value = ctr_args;
        this.anonymousType = anonymousType;
    }

    get label() {
        // don't include the implicit modifiers in the label
        return `${this.owner.simpleTypeName} ${this.name}`;
    }

    get name() {
        return this.ident.value;
    }

    get type() {
        return this.owner;
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
     * @param {string} docs 
     * @param {Token[]} modifiers 
     * @param {SourceTypeIdent} field_type_ident 
     * @param {Token} name_token 
     * @param {ResolvedIdent} init
     */
    constructor(owner, docs, modifiers, field_type_ident, name_token, init) {
        super(modifiers.map(m => m.value), docs);
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
     * @param {string} docs 
     * @param {TypeVariable[]} type_vars 
     * @param {Token[]} modifiers 
     * @param {SourceParameter[]} parameters 
     * @param {JavaType[]} throws 
     * @param {Token[]} body_tokens 
     */
    constructor(owner, docs, type_vars, modifiers, parameters, throws, body_tokens) {
        super(owner, modifiers.map(m => m.value), docs);
        this.owner = owner;
        this.typeVars = type_vars;
        this.modifierTokens = modifiers;
        this.sourceParameters = parameters;
        this.throws = throws;
        this.body = {
            tokens: body_tokens,
            /** @type {import('./body-types').Local[]} */
            locals: [],
        }
        this.parsed = null;
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

    get typeVariables() {
        return this.typeVars;
    }
}

class SourceMethod extends Method {
    /**
     * @param {SourceType} owner 
     * @param {string} docs 
     * @param {TypeVariable[]} type_vars 
     * @param {Token[]} modifiers 
     * @param {SourceAnnotation[]} annotations
     * @param {SourceTypeIdent} method_type_ident 
     * @param {Token} name_token 
     * @param {SourceParameter[]} parameters 
     * @param {JavaType[]} throws 
     * @param {Token[]} body_tokens 
     */
    constructor(owner, docs, type_vars, modifiers, annotations, method_type_ident, name_token, parameters, throws, body_tokens) {
        super(owner, name_token ? name_token.value : '', modifiers.map(m => m.value), docs);
        this.annotations = annotations;
        this.owner = owner;
        this.typeVars = type_vars;
        this.modifierTokens = modifiers;
        this.returnTypeIdent = method_type_ident;
        this.nameToken = name_token;
        this.sourceParameters = parameters;
        this.throws = throws;
        this.body = {
            tokens: body_tokens,
            /** @type {import('./body-types').Local[]} */
            locals: [],
        }
        this.parsed = null;
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
     * @param {string} docs
     * @param {Token[]} modifiers 
     * @param {Token[]} body_tokens
     */
    constructor(owner, docs, modifiers, body_tokens) {
        super(owner, modifiers.map(m => m.value), docs);
        /** @type {SourceType} */
        this.owner = owner;
        this.modifierTokens = modifiers;
        this.body = {
            tokens: body_tokens,
            /** @type {import('./body-types').Local[]} */
            locals: [],
        }
        this.parsed = null;
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
    /** @type {string} */
    uri = '';
    /** @type {Token[]} */
    tokens = [];
    /** @type {SourcePackage} */
    package_ = null;
    /** @type {SourceImport[]} */
    imports = [];
    /** @type {SourceType[]} */
    types = [];

    /**
     * @param {Token} token 
     */
    getSourceMethodAtToken(token) {
        if (!token) {
            return null;
        }
        for (let type of this.types) {
            for (let method of type.sourceMethods) {
                if (method.body && method.body.tokens && method.body.tokens.includes(token)) {
                    return method;
                }
            }
        }
        return null;
    }

    /**
     * @param {number} char_index 
     */
    getTokenAt(char_index) {
        let i = 0;
        for (let tok of this.tokens) {
            if (char_index > tok.range.start + tok.range.length) {
                i++;
                continue;
            }
            while (i > 0 && tok.kind === 'wsc') {
                tok = this.tokens[--i];
            }
            return tok;
        }
        return null;
    }

    /**
     * 
     * @param {number} char_index 
     */
    getCompletionOptionsAt(char_index) {
        const token = this.getTokenAt(char_index);
        const method = this.getSourceMethodAtToken(token);
        // we should also include local variables here, but
        // it's currently difficult to map an individual token to a scope
        return {
            index: char_index,
            loc: token && token.loc,
            method,
        };
    }

    /**
     * Return the name of the package this unit belongs to
     */
    get packageName() {
        return (this.package_ && this.package_.name) || '';
    }
}

class SourceArrayType extends ArrayType {
    /**
     * 
     * @param {JavaType} element_type 
     */
    constructor(element_type) {
        super(element_type, 1);
        this.parent_type = element_type;
    }
    get label() {
        return `${this.parent_type.label}[]`;
    }
}

class FixedLengthArrayType extends SourceArrayType {
    /**
     * 
     * @param {JavaType} element_type 
     * @param {ResolvedIdent} length 
     */
    constructor(element_type, length) {
        super(element_type);
        this.length = length;
    }

    get label() {
        return `${this.parent_type.label}[${this.length.source}]`;
    }
}

/**
 * @typedef {SourceMethod|SourceConstructor|SourceInitialiser} SourceMethodLike
 */

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
exports.SourceEnumValue = SourceEnumValue;
exports.SourceArrayType = SourceArrayType;
exports.FixedLengthArrayType = FixedLengthArrayType;
