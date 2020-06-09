const { JavaType, CEIType, PrimitiveType, Constructor, Method, MethodBase, Field, Parameter, TypeVariable, UnresolvedType } = require('java-mti');
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
     * @param {TypeDeclBlock} type
     * @param {string} qualified_type_name qualified $-separated type name
     * @param {Map<string,JavaType>} typemap
     */
    constructor(mod, type, qualified_type_name, typemap) {
        super(type.shortSignature, type.kind(), mapmods(type), type.docs);
        this._decl = type;
        this._dottedTypeName = qualified_type_name.replace(/\$/g, '.');

        this.extends_types = type.extends_decl ? extractTypeList(type.extends_decl) : [];
        this.implements_types = type.implements_decl ? extractTypeList(type.implements_decl) : [];
        this.implicit_extend = !this.extends_types.length && !this.implements_types.length ? [typemap.get('java/lang/Object')] : [];
        
        this.fields = type.fields.map(f => new SourceField(this, f));
        this.methods = type.methods.map(m => new SourceMethod(this, m));
        /** @type {Constructor[]} */
        this.constructors = type.constructors.map(c => new SourceConstructor(this, c));
        if (!type.constructors[0] && type.kind() === 'class') {
            // add a default public constructor if this is a class with no explicit constructors
            this.constructors.push(new DefaultConstructor(this));
        }
        this.initers = type.initialisers.map(i => new SourceInitialiser(this, i));
        super.typevars = type.typevars.map(tv => {
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

    getAllResolvableTypes() {
        /** @type {ResolvableType[]} */
        const res = [
            ...this.extends_types,
            ...this.implements_types,
        ];
        this.fields.forEach(f => res.push(f._type));
        this.methods.forEach(m => {
            res.push(m._returnType);
            m.parameters.forEach(p => res.push(p._paramType));
        });
        this.constructors.forEach(c => {
            if (c instanceof SourceConstructor) {
                c.parameters.forEach(p => res.push(p._paramType));
            }
        });
        return res;
    }
}

class SourceField extends Field {
    /**
     * @param {SourceType} owner
     * @param {FieldBlock} decl 
     */
    constructor(owner, decl) {
        super(mapmods(decl), decl.docs);
        this._owner = owner;
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
        super(mapmods(decl), decl.docs);
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
        super(['public']);
        this._owner = owner;
    }

    get methodSignature() {
        return `()V`;
    }

    /**
     * @returns {SourceType}
     */
    get returnType() {
        return this._owner;
    }
}


class SourceInitialiser extends MethodBase {
    /**
     * @param {SourceType} owner
     * @param {InitialiserBlock} decl 
     */
    constructor(owner, decl) {
        super(mapmods(decl), decl.docs);
        this._owner = owner;
        this._decl = decl;
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
        super(decl.name, mapmods(decl), decl.docs);
        this._owner = owner;
        this._decl = decl;
        this._parameters = decl.parameters.map((p,i) => new SourceParameter(p));
        this._returnType = new ResolvableType(decl);
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
