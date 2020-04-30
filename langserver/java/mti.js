
/**
 * @param {number} ref 
 * @param {MTI} mti
 * @returns {string}
 */
function packageNameFromRef(ref, mti) {
    if (typeof ref !== 'number') {
        return null;
    }
    if (ref < 16) {
        return KnownPackages[ref];
    }
    return mti.minified.rp[ref - 16];
}

/**
 * @param {number} ref 
 * @param {MTI} mti
 */
function typeFromRef(ref, mti) {
    if (typeof ref !== 'number') {
        return null;
    }
    if (ref < 16) {
        return KnownTypes[ref];
    }
    return mti.referenced.types[ref - 16];
}

function indent(s) {
    return '\n' + s.split('\n').map(s => `    ${s}`).join('\n');
}

class MinifiableInfo {

    constructor(minified) {
        this.minified = minified;
    }

    /**
     * Format a commented form of docs with a newline at the end.
     */
    fmtdocs() {
        // the docs field is always d in the minified objects
        const d = this.minified.d;
        return d ? `/**\n * ${d.replace(/\n/g,'\n *')}\n */\n` : '';
    }
}

/**
 * Minified Type Information
 * 
 * Each MTI instance represents a Java unit (a single source file or a compiled class file).
 * The mti JSON format is minimalistic to keep the size small - the Android framework has over 8000 classes in
 * it, so keeping the information as small as possible is beneficial.
 * ```
        mti: {
           rp:[],       // referenced packages
           rt:[],       // referenced types
           it:[{        // implemented types
             m:0,       // type modifiers
             n:'',      // type name (in X$Y format)
             p:null,    // owner package
             v:[],      // type vars
             e:null,    // extends 0(class)/[0,...](interface)/null(unknown)
             i:[],      // implements [0,...]
             c:[],      // constructors [{m:0,p:[]},...]
             f:[],      // fields {m:0,n:'',t:0},
             g:[],      // methods {n:'',s:[{m:0,t:0,p:[{m:0,t:0,n:''},...]}]}
             u:[],      // subtypes [0,...]
             d:'',      // type docs
            }]
        },
    ```
 */
class MTI extends MinifiableInfo {

    /**
     * @param {{rp:[], rt:[], it:[]}} mti 
     */
    constructor(mti) {
        super(mti);
        // initialise the lists of referenced packages and types
        this.referenced = {
            /** @type {string[]} */
            packages: mti.rp,

            /** @type {ReferencedType[]} */
            types: [],
        }
        // because ReferencedType can make use of earlier reference types, we must add them sequentially
        // instead of using mti.rt.map()
        for (let t of mti.rt) {
            this.referenced.types.push(new ReferencedType(this, t))
        }

        // add the types implemented by this unit
        this.types = mti.it.map(it => new MTIType(this, it));
    }

    /**
     * Unpack all the classes from the given JSON
     * @param {string} filename 
     */
    static unpackJSON(filename) {
        const o = JSON.parse(require('fs').readFileSync(filename, 'utf8'));
        delete o.NOTICES;
        const types = [];
        for (let pkg in o) {
            for (let cls in o[pkg]) {
                const unit = new MTI(o[pkg][cls]);
                types.push(...unit.types);
            }
        }
        return {
            packages: Object.keys(o).sort(),
            types: types.sort((a,b) => a.minified.n.localeCompare(b.minified.n)),
        }
    }
}

/**
 * A ReferencedType encodes a type used by a class, interface or enum.
 * ```
 * {
 *      n: string | typeref - name or base typeref (for arrays and generic types)
 *      p?: pkgref - package the type is declared in (undefined for primitives)
 *      g?: typeref[] - generic type parameters
 *      a?: number - array dimensions
 * }
 * ```
 * 
 * A typeref value < 16 is a lookup into the KnownTypes array.
 * 
 * All other types have a typeref >= 16 and an associated package reference.
 * 
 * The packageref is a lookup into the MTIs pt array which lists package names.
 */
class ReferencedType extends MinifiableInfo {

    /**
     * @param {MTI} unit
     * @param {*} mti 
     * @param {string|false} [pkg_or_prim] predefined package name, an empty string for default packages or false for primitives
     * @param {*} [default_value] 
     */
    constructor(unit, mti, pkg_or_prim, default_value = null) {
        super(mti);
        let baseType;
        if (typeof mti.n === 'number') {
            baseType = typeFromRef(mti.n, unit);
        }
        this.parsed = {
            package: pkg_or_prim 
                || ((pkg_or_prim === false) 
                    ? undefined 
                    : packageNameFromRef(mti.p, unit)
                    ),

            /** @type {ReferencedType} */
            baseType,

            /** @type {ReferencedType[]} */
            typeParams: mti.g && mti.g.map(t => typeFromRef(t, unit)),

            /** @type {string} */
            arr: '[]'.repeat(mti.a | 0),
        }
        this.defaultValue = default_value;
    }

    get isPrimitive() { return this.parsed.package === undefined }

    get package() { return this.parsed.package }

    get name() {
        // note: names in enclosed types are in x$y format
        const n = this.parsed.baseType ? this.parsed.baseType.name : this.minified.n;
        const type_params = this.parsed.typeParams
            ? `<${this.parsed.typeParams.map(tp => tp.name).join(',')}>`
            : ''
        return `${n}${type_params}${this.parsed.arr}`;
    }

    get dottedName() {
        return this.name.replace(/[$]/g, '.');
    }
}


/**
 * MTIType encodes a complete type (class, interface or enum)
 * ```
 * {
 *   d: string - type docs
 *   p: pkgref - the package this type belongs to
 *   n: string - type name (in x$y format for enclosed types)
 *   v: typeref[] - generic type variables
 *   e: typeref | typeref[] - super/extends type (single value for classes, array for interfaces)
 *   i: typeref[] - interface types
 *   f: mtifield[] - fields
 *   c: mtictrs[] - constructors
 *   g: mtimethod[] - methods
 * }
 * ```
 */
class MTIType extends MinifiableInfo {

    /**
     * @param {MTI} unit 
     * @param {*} mti 
     */
    constructor(unit, mti) {
        super(mti);
        this.parsed = {
            package: packageNameFromRef(mti.p, unit),
            
            /** @type {ReferencedType[]} */
            typevars: mti.v.map(v => typeFromRef(v, unit)),

            /** @type {ReferencedType|ReferencedType[]} */
            extends: Array.isArray(mti.e)
                ? mti.e.map(e => typeFromRef(e, unit))
                : typeFromRef(mti.e, unit),

            /** @type {ReferencedType[]} */
            implements: mti.i.map(i => typeFromRef(i, unit)),

            /** @type {MTIField[]} */
            fields: mti.f.map(f => new MTIField(unit, f)),

            /** @type {MTIConstructor[]} */
            constructors: mti.c.map(c => new MTIConstructor(unit, c)),

            /**
             * MTI method are grouped by name - we split them here 
             * @type {MTIMethod[]}
             */
            methods: mti.g.reduce((arr, m) => [...arr, ...MTIMethod.split(unit, this, m)], []),
        }
    }

    /**
     * type docs
     * @type {string}
     */
    get docs() { return this.minified.d }

    /**
     * type modifiers
     * @type {number}
     */
    get modifiers() { return this.minified.m }
    
    /**
     * type name (in x$y format for enclosed types)
     * @type {string}
     */
    get name() { return this.minified.n }

    get dottedRawName() { return this.minified.n.replace(/[$]/g, '.') };

    get dottedName() {
        const t = this.typevars.map(t => t.name).join(',');
        return t ? `${this.dottedRawName}<${t}>` : this.dottedRawName;
    };

    /**
     * type name with no qualifiers
     * @type {string}
     */
    get simpleRawName() { return this.minified.n.match(/[^$]+$/)[0] }

    /**
     * package this type belongs to
     */
    get package() { return this.parsed.package }

    get typeKind() {
        const m = this.minified.m;
        return (m & TypeModifiers.enum)
            ? 'enum' : (m & TypeModifiers.interface)
            ? 'interface' : (m & TypeModifiers['@interface'])
            ? '@interface' : 'class';
    }

    /**
     * generic type variables
     */
    get typevars() { return this.parsed.typevars }

    /**
     * class or interface extends.
     * Note that classes have a single extend type, but interfaces have an array.
     */
    get extends() { return this.parsed.extends }

    /**
     * class implements
     */
    get implements() { return this.parsed.implements }

    /**
     * @type {MTIConstructor[]}
     */
    get constructors() { return this.parsed.constructors }

    /**
     * @type {MTIField[]}
     */
    get fields() { return this.parsed.fields }

    /**
     * @type {MTIMethod[]}
     */
    get methods() { return this.parsed.methods }

    toSource() {
        let constructors = [], typevars = '', ex = '', imp = '';

        // only add constructors if there's more than just the default constructor
        if (!((this.constructors.length === 1) && (this.constructors[0].parameters.length === 0))) {
            constructors = this.constructors;
        }

        if (this.typevars.length) {
            typevars = `<${this.typevars.map(tv => tv.name).join(',')}>`;
        }

        if (this.extends) {
            // only add extends if it's not derived from java.lang.Object
            if (this.extends !== KnownTypes[3]) {
                const x = Array.isArray(this.extends) ? this.extends : [this.extends];
                ex = `extends ${x.map(type => type.dottedName).join(', ')} `;
            }
        }

        if (this.implements.length) {
            imp = `implements ${this.implements.map(type => type.dottedName).join(', ')} `;
        }

        return [
            `${this.fmtdocs()}${typemods(this.modifiers)} ${this.simpleRawName}${typevars} ${ex}${imp}{`,
            ...this.fields.map(f => indent(f.toSource())),
            ...constructors.map(c => indent(c.toSource())),
            ...this.methods.map(m => indent(m.toSource())),
            `}`
        ].join('\n');
    }
}

/**
 * MTIField encodes a single type field.
 * ```
 * {
 *   d: string - docs
 *   m: number - access modifiers
 *   n: string - field name
 *   t: typeref - field type
 * }
 * ```
 */
class MTIField extends MinifiableInfo {

    /**
     * @param {MTI} owner 
     * @param {*} mti 
     */
    constructor(owner, mti)  {
        super(mti);
        this.parsed = {
            type: typeFromRef(mti.t, owner),
        };
    }

    /**
     * @type {number}
     */
    get modifiers() { return this.minified.m }

    /**
     * @type {string}
     */
    get docs() { return this.minified.d }

    /**
     * @type {string}
     */
    get name() { return this.minified.n }

    /**
     * @type {ReferencedType}
     */
    get type() { return this.parsed.type }

    toSource() {
        return `${this.fmtdocs()}${access(this.modifiers)}${this.type.dottedName} ${this.name} = ${this.type.defaultValue};`
    }
}

class MTIMethodBase extends MinifiableInfo {}

/**
 * MTIContructor encodes a single type constructor.
 * ```
 * {
 *   d: string - docs
 *   m: number - access modifiers
 *   p: mtiparam[] - constructor parameters
 * }
 * ```
 */
class MTIConstructor extends MTIMethodBase {

    /**
     * @param {MTI} owner
     * @param {*} mti 
     */
    constructor(owner, mti)  {
        super(mti);
        this.parsed = {
            typename: owner.minified.it[0].n,
            /** @type {MTIParameter[]} */
            parameters: mti.p.map(p => new MTIParameter(owner, p)),
        }
    }

    /**
     * @type {number}
     */
    get modifiers() { return this.minified.m }

    get docs() { return this.minified.d }

    /**
     * @type {MTIParameter[]}
     */
    get parameters() { return this.parsed.parameters }

    toSource() {
        const typename = this.parsed.typename.split('$').pop();
        return `${this.fmtdocs()}${access(this.modifiers)}${typename}(${this.parameters.map(p => p.toSource()).join(', ')}) {}`
    }
}

/**
 * MTIMethod encodes a single type method.
 * 
 * In minified form, methods are encoded as overloads - each entry
 * has a single name with one or more method signatures.
 * ```
 * {
 *   d: string - docs
 *   n: string - method name
 *   s: [{
 *         m: number - access modifiers
 *         t: typeref - return type
 *         p: mtiparam[] - method parameters
 *      },
 *      ...
 *   ]
 *  
 * }
 * ```
 */
 class MTIMethod extends MTIMethodBase {

    /**
     * @param {MTI} unit 
     * @param {MTIType} type
     * @param {string} name
     * @param {*} mti 
     */
    constructor(unit, type, name, mti)  {
        super(mti);
        this.interfaceMethod = type.modifiers & 0x200;
        this.parsed = {
            name,
            /** @type {MTIParameter[]} */
            parameters: mti.p.map(p => new MTIParameter(unit, p)),
            /** @type {ReferencedType} */
            return_type: typeFromRef(mti.t, unit),
        }
    }

    /**
     * @param {MTI} unit 
     * @param {MTIType} type
     * @param {*} mti 
     */
    static split(unit, type, mti) {
        return mti.s.map(s => new MTIMethod(unit, type, mti.n, s));
    }

    /**
     * @type {string}
     */
    get docs() { return this.minified.d }

    /**
     * @type {number}
     */
    get modifiers() { return this.minified.m }

    /**
     * @type {ReferencedType}
     */
    get return_type() { return this.parsed.return_type }

    /**
     * @type {string}
     */
    get name() { return this.parsed.name }

    /**
     * @type {MTIParameter[]}
     */
    get parameters() { return this.parsed.parameters }

    toSource() {
        let m = this.modifiers, body = ' {}';
        if (m & 0x400) {
            body = ';'; // abstract method - no body
        } else if (this.return_type.name !== 'void') {
            body = ` { return ${this.return_type.defaultValue}; }`;
        }
        if (this.interfaceMethod) {
            m &= ~0x400;    // exclude abstract modifier as it's redundant
        }
        return `${this.fmtdocs()}${access(m)}${this.return_type.dottedName} ${this.name}(${this.parameters.map(p => p.toSource()).join(', ')})${body}`
    }
}

/**
 * MTIParameter encodes a single method or constructor paramter
 * ```
 * {
 *   m?: number - access modifiers (only 'final' is allowed)
 *   t: typeref - parameter type
 *   n: string - parameter name
 * }
 * ```
 */
class MTIParameter extends MinifiableInfo {

    /**
     * @param {MTI} owner 
     * @param {*} mti 
     */
    constructor(owner, mti) {
        super(mti);
        this.parsed = {
            type: typeFromRef(mti.t, owner)
        }
    }

    /**
     * @type {number}
     */
    get modifiers() { return this.minified.m | 0 }

    /**
     * @type {string}
     */
    get name() { return this.minified.n }

    /**
     * @type {ReferencedType}
     */
    get type() { return this.parsed.type }

    toSource() {
        return `${access(this.modifiers)}${this.type.dottedName} ${this.name}`
    }
}

const access_keywords = 'public private protected static final synchronized volatile transient native interface abstract strict'.split(' ');

/**
 * @param {number} modifier_bits 
 */
function access(modifier_bits) {
    // convert the modifier bits into keywords
    const decls = access_keywords.filter((_,i) => modifier_bits & (1 << i));
    if (decls.length) {
        decls.push(''); // make sure we end with a space
    }
    return decls.join(' ');
}

const TypeModifiers = {
    public:       0b0000_0000_0000_0001,    // 0x1
    final:        0b0000_0000_0001_0000,    // 0x10
    interface:    0b0000_0010_0000_0000,    // 0x200
    abstract:     0b0000_0100_0000_0000,    // 0x400
    '@interface': 0b0010_0000_0000_0000,    // 0x2000
    enum:         0b0100_0000_0000_0000,    // 0x4000
}

/**
 * @param {number} modifier_bits 
 */
function typemods(modifier_bits) {
    const modifiers = [];
    let type = 'class';
    if (modifier_bits & TypeModifiers.interface) {
        type = 'interface';
        modifier_bits &= ~TypeModifiers.abstract;    // ignore abstract keyword for interfaces
    } else if (modifier_bits & TypeModifiers['@interface']) {
        type = '@interface';
    } else if (modifier_bits & TypeModifiers.enum) {
        type = 'enum';
        modifier_bits &= ~TypeModifiers.final;    // ignore final keyword for enums
    }
    if (modifier_bits & TypeModifiers.public) modifiers.push('public');
    if (modifier_bits & TypeModifiers.final) modifiers.push('final');
    if (modifier_bits & TypeModifiers.abstract) modifiers.push('abstract');
    modifiers.push(type);
    return modifiers.join(' ');
}

/**
 * List of known/common packages.
 * These are used/encoded as pkgrefs between 0 and 15.
 */
const KnownPackages = ["java.lang","java.io","java.util",""];

/**
 * Literals corresponding to the KnownTypes.
 * These are used for method return values and field expressions when constructing source.
 */
const KnownTypeValues = ['','0','""','null','false',"'\\0'",'0','0l','0','0.0f','0.0d','null'];

/**
 * List of known/common types.
 * These are used/encoded as typerefs between 0 and 15.
 */
const KnownTypes = [
    "void","int","String","Object","boolean","char","byte","long","short","float","double","Class"
].map((n,i) => {
    const pkg_or_prim = /^[SOC]/.test(n) ? KnownPackages[0] : false;
    return new ReferencedType(null, {n}, pkg_or_prim, KnownTypeValues[i]);
});

module.exports = MTI;
