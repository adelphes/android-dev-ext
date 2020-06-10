const { JavaType, ArrayType, CEIType, NullType, PrimitiveType, TypeVariableType, Constructor, Method, MethodBase, Field, Parameter, TypeVariable, UnresolvedType, signatureToType } = require('java-mti');
const { ModuleBlock, TypeDeclBlock, FieldBlock, ConstructorBlock, MethodBlock, InitialiserBlock, ParameterBlock, TextBlock } = require('./parser9');

/**
 * 
 * @param {{modifiers:TextBlock[]}} x 
 */
function mapmods(x) {
    return x.modifiers.map(m => m.source);
}

/**
 * 
 * @param {TextBlock} decl 
 */
function extractTypeList(decl) {
    if (!decl) {
        return [];
    }
    const types = [];
    const re = /[WD]( *[WDT.])*/g;
    const declba = decl.blockArray();
    const sm = declba.sourcemap();
    for (let m; m  = re.exec(sm.simplified);) {
        const start = sm.map[m.index], end = sm.map[m.index + m[0].length-1];
        const block_range = declba.blocks.slice(start, end+1);
        types.push(block_range);
    }
    return types.map(tokens => {
        const decl = {
            type: tokens.map(t => t.source).join(''),
            typeTokens: tokens,
        }
        return new ResolvableType(decl);
    });
}

class SourceType extends CEIType {
    /**
     * @param {ModuleBlock} mod 
     * @param {TypeDeclBlock} decl
     * @param {string} qualified_type_name qualified $-separated type name
     * @param {Map<string,JavaType>} typemap
     */
    constructor(mod, decl, qualified_type_name, typemap) {
        super(decl.shortSignature, decl.kind(), mapmods(decl), decl.docs);
        this._typemap = typemap;
        this._decl = decl;
        this._dottedTypeName = qualified_type_name.replace(/\$/g, '.');

        this.extends_types = decl.extends_decl ? extractTypeList(decl.extends_decl) : [];
        this.implements_types = decl.implements_decl ? extractTypeList(decl.implements_decl) : [];
        this.implicit_extend = !this.extends_types.length && !this.implements_types.length ? [typemap.get('java/lang/Object')] : [];
        
        this.fields = decl.fields.map(f => new SourceField(this, f));
        this.methods = decl.methods.map(m => new SourceMethod(this, m));

        /**
         * constructors coded in the source
         */
        this.declaredConstructors = decl.constructors.map(c => new SourceConstructor(this, c));

        /**
         * Callable constructors for the type - if the type does not explicitly declare
         * any constructors, an implicit default constructor is included
         * @type {Constructor[]}
         * */
        this.constructors = this.declaredConstructors;
        if (!decl.constructors[0] && decl.kind() === 'class') {
            // add a default public constructor if this is a class with no explicit constructors
            this.constructors = [new DefaultConstructor(this)];
        }

        /**
         * The class initialisers
         */
        this.initers = decl.initialisers.map(i => new SourceInitialiser(this, i));

        super.typeVariables = decl.typevars.map(tv => {
            const typevar = new TypeVariable(this, tv.name);
            // automatically add the Object bound
            typevar.bounds.push(new TypeVariable.Bound(this, 'Ljava/lang/Object;', false));
            return typevar;
        });
    }

    get dottedTypeName() {
        return this._dottedTypeName;
    }

    get fullyDottedRawName() {
        return this._decl.fullyDottedName;
    }

    get fullyDottedTypeName() {
        return this._decl.fullyDottedName;
    }

    get supers() {
        return [
            ...this.implicit_extend,
            ...this.extends_types.map(t => t.resolved),
            ...this.implements_types.map(t => t.resolved)
        ];
    }

    /**
     * @param {string} signature 
     * @param {TypeVariable[]} [typevars]
     * @returns {JavaType}
     */
    resolveType(signature, typevars = []) {
        return signatureToType(signature, this._typemap, [...typevars, ...this.typeVariables]);
    }
}

class SourceField extends Field {
    /**
     * @param {SourceType} owner
     * @param {FieldBlock} decl 
     */
    constructor(owner, decl) {
        super(mapmods(decl), decl.docs);
        this._decl = decl;
        this._type = new ResolvableType(decl);
    }

    get name() {
        return this._decl.name;
    }

    get type() {
        return this._type.resolved;
    }
}

class SourceConstructor extends Constructor {
    /**
     * @param {SourceType} owner
     * @param {ConstructorBlock} decl 
     */
    constructor(owner, decl) {
        super(owner, mapmods(decl), decl.docs);
        this._owner = owner;
        this._decl = decl;
        this._parameters = decl.parameters.map((p,i) => new SourceParameter(p));
    }

    get methodSignature() {
        return `(${this._parameters.map(p => p.type.typeSignature).join('')})V`;
    }

    /**
     * @returns {SourceParameter[]}
     */
    get parameters() {
        return this._parameters;
    }

    /**
     * @returns {SourceType}
     */
    get returnType() {
        return this._owner;
    }
}

class DefaultConstructor extends Constructor {
    /**
     * @param {SourceType} owner 
     */
    constructor(owner) {
        super(owner, ['public'], '');
        this.owner = owner;
    }

    get methodSignature() {
        return `()V`;
    }

    /**
     * @returns {SourceType}
     */
    get returnType() {
        return this.owner;
    }
}


class SourceInitialiser extends MethodBase {
    /**
     * @param {SourceType} owner
     * @param {InitialiserBlock} decl 
     */
    constructor(owner, decl) {
        super(owner, mapmods(decl), decl.docs);
        this.owner = owner;
        this._decl = decl;
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

class SourceMethod extends Method {
    /**
     * @param {SourceType} owner
     * @param {MethodBlock} decl 
     */
    constructor(owner, decl) {
        super(owner, decl.name, mapmods(decl), decl.docs);
        this.owner = owner;
        this._decl = decl;
        this._parameters = decl.parameters.map((p,i) => new SourceParameter(p));
        this._returnType = new ResolvableType(decl);
        /** @type {TypeVariable[]} */
        this._typevars = decl.typeVariables.map(tv => {
            const typevar = new TypeVariable(owner, tv.name);
            // automatically add the Object bound
            typevar.bounds.push(new TypeVariable.Bound(owner, 'Ljava/lang/Object;', false));
            return typevar;
        });
    }

    /**
     * @returns {SourceParameter[]}
     */
    get parameters() {
        return this._parameters;
    }

    get returnType() {
        return this._returnType.resolved;
    }

    get typeVariables() {
        return this._typevars;
    }
}

class SourceParameter extends Parameter {
    /**
     * @param {ParameterBlock} decl 
     * @param {ResolvableType} [type]
     */
    constructor(decl, type = new ResolvableType(decl)) {
        super(decl.name, type, decl.isVarArgs);
        this._decl = decl;
        this._paramType = type;
    }

    get type() {
        if (this.varargs) {
            // variable arity parameters are automatically an array type
            return new ArrayType(this._paramType.resolved, 1);
        }
        return this._paramType.resolved;
    }
}

class ResolvableType extends UnresolvedType {
    /**
     * 
     * @param {{type:string, typeTokens:TextBlock[]}} decl 
     */
    constructor(decl) {
        super(decl.type);
        this._decl = decl;
        /** @type {JavaType} */
        this._resolved = null;
    }

    /**
     * @returns {JavaType}
     */
    get resolved() {
        return this._resolved || this;
    }

    get typeTokens() {
        return this._decl.typeTokens;
    }
}

exports.SourceType = SourceType;
exports.SourceField = SourceField;
exports.SourceMethod = SourceMethod;
exports.SourceParameter = SourceParameter;
exports.SourceConstructor = SourceConstructor;
exports.DefaultConstructor = DefaultConstructor;
exports.SourceInitialiser = SourceInitialiser;
exports.ResolvableType = ResolvableType;
